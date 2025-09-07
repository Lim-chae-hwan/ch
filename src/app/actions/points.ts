'use server';

import { sql } from 'kysely';
import { kysely } from './kysely';
import { currentSoldier, fetchSoldier } from './soldiers';
import { hasPermission } from './utils';

/** ✅ 안전한 bigint 파서: 잘못된 값이면 null */
function parsePointId(idLike: string): number | null {
  const n = Number(idLike);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

export async function fetchPoint(pointId: string) {
  /** ✅ 가드: NaN/이상 값이면 DB에 질의하지 않고 null 반환 */
  const id = parsePointId(pointId);
  if (id === null) return null;

  return kysely
    .selectFrom('points')
    .where('id', '=', id) // ⬅️ Number(pointId) → id
    .leftJoin('soldiers as g', 'g.sn', 'points.giver_id')
    .leftJoin('soldiers as r', 'r.sn', 'points.receiver_id')
    .selectAll(['points'])
    // Explicitly select approver_id to ensure it is available in the result
    .select([
      'points.approver_id',
      'points.status',
      'points.rejected_reason',
      'r.name as receiver',
      'g.name as giver',
    ])
    .executeTakeFirst();
}

export async function listPoints(sn: string) {
  const { type } = await kysely
    .selectFrom('soldiers')
    .where('sn', '=', sn)
    .select('type')
    .executeTakeFirstOrThrow();

  const query = kysely
    .selectFrom('points')
    .where(type === 'enlisted' ? 'receiver_id' : 'giver_id', '=', sn);

  const [data, usedPoints] = await Promise.all([
    query
      .orderBy('created_at desc')
      .select(['id', 'status', 'rejected_reason'])
      .execute(),
    type === 'enlisted' &&
      kysely
        .selectFrom('used_points')
        .where('user_id', '=', sn)
        .leftJoin('soldiers', 'soldiers.sn', 'used_points.recorded_by')
        .select('soldiers.name as recorder')
        .selectAll(['used_points'])
        .execute(),
  ]);

  return { data, usedPoints: usedPoints || null };
}

export async function LoadCommanders() {
  const result = await kysely
    .selectFrom('soldiers')
    .innerJoin('permissions', 'soldiers.sn', 'permissions.soldiers_id')
    .select(['soldiers.sn as sn', 'soldiers.name as name', 'soldiers.unit as unit'])
    .where('permissions.value', '=', 'Commander')
    .execute();

  return result; // [{ sn: '12345678901', name: '홍길동', unit: '1중대' }, ...]
}

export async function fetchPendingPoints() {
  const current = await currentSoldier();

  if (!hasPermission(current.permissions, ['Commander'])) return [];

  return kysely
    .selectFrom('points as p')
    .leftJoin('soldiers as g', 'p.giver_id',    'g.sn')
    .leftJoin('soldiers as r', 'p.receiver_id', 'r.sn')
    .where('p.approver_id', '=', current.sn)
    .where('p.status', '=', 'pending')
    /* ✅ 콜백 스타일 */
    .select(({ ref, fn }) => [
      'p.id',
      'p.value',
      'p.reason',
      'p.given_at',
      'p.status',
      'p.rejected_reason',
      // 이름이 null이면 군번을 사용
      fn.coalesce(ref('g.name'), ref('p.giver_id')).as('giver'),
      fn.coalesce(ref('r.name'), ref('p.receiver_id')).as('receiver'),
    ])
    .orderBy('p.given_at desc')
    .execute();
}

export async function fetchPointsCountsNco() {
  const { sn } = await currentSoldier();
  const query = kysely
    .selectFrom('points')
    .where('giver_id', '=', sn!);

  const [{ verified }, { pending }, { rejected }] = await Promise.all([
    query
      .where('status', '=', 'approved')
      .select((eb) => eb.fn.count<number>('id').as('verified'))
      .executeTakeFirstOrThrow(),
    query
      .where('status', '=', 'pending')
      .select((eb) => eb.fn.count<number>('id').as('pending'))
      .executeTakeFirstOrThrow(),
    query
      .where('status', '=', 'rejected')
      .select((eb) => eb.fn.count<number>('id').as('rejected'))
      .executeTakeFirstOrThrow(),
  ]);

  return { verified, pending, rejected };
}

export async function fetchPointsCountsEnlisted() {
  const { sn } = await currentSoldier();
  const query = kysely
    .selectFrom('points')
    .where('receiver_id', '=', sn!);

  const [{ verified }, { pending }, { rejected }] = await Promise.all([
    query
      .where('status', '=', 'approved')
      .select((eb) => eb.fn.count<number>('id').as('verified'))
      .executeTakeFirstOrThrow(),
    query
      .where('status', '=', 'pending')
      .select((eb) => eb.fn.count<number>('id').as('pending'))
      .executeTakeFirstOrThrow(),
    query
      .where('status', '=', 'rejected')
      .select((eb) => eb.fn.count<number>('id').as('rejected'))
      .executeTakeFirstOrThrow(),
  ]);

  return { verified, pending, rejected };
}

export async function deletePoint(pointId: string) {
  const { type, sn } = await currentSoldier();
  if (type === 'nco') {
    return { message: '간부는 상벌점을 지울 수 없습니다' };
  }

  /** ✅ 가드 */
  const id = parsePointId(pointId);
  if (id === null) {
    return { message: '유효하지 않은 상벌점 ID입니다' };
  }

  const data = await fetchPoint(pointId);
  if (data == null) {
    return { message: '상벌점이 존재하지 않습니다' };
  }
  if (data.receiver_id !== sn) {
    return { message: '본인 상벌점만 삭제 할 수 있습니다' };
  }
  if (data.status !== 'pending') {
    return { message: '이미 처리된 상벌점은 지울 수 없습니다' };
  }
  try {
    await kysely
      .deleteFrom('points')
      .where('id', '=', id) // ⬅️ Number(pointId) → id
      .executeTakeFirstOrThrow();
  } catch (_e) {
    return { message: '알 수 없는 오류가 발생했습니다' };
  }
  return { message: null };
}

export async function verifyPoint(
  pointId: string,
  value: boolean,
  rejectReason?: string,
) {
  /** ✅ 가드 */
  const id = parsePointId(pointId);
  if (id === null) {
    return { message: '유효하지 않은 상벌점 ID입니다' };
  }

  const [point, current] = await Promise.all([
    fetchPoint(pointId),
    currentSoldier(),
  ]);

  if (point == null) {
    return { message: '본 상벌점이 존재하지 않습니다' };
  }

  if (point.approver_id !== current.sn) {
    return { message: '본인에게 요청된 상벌점만 승인/반려 할 수 있습니다' };
  }

  if (!value && (!rejectReason || !rejectReason.trim())) {
    return { message: '반려 사유를 입력해주세요' };
  }

  try {
    await kysely
      .updateTable('points')
      .where('id', '=', id) // ⬅️ Number(pointId) → id
      .set(
        value
          ? {
              status: 'approved',
              approved_at: new Date(),
              rejected_reason: null,
              rejected_at: null,
            }
          : {
              status: 'rejected',
              rejected_at: new Date(),
              rejected_reason: rejectReason!.trim(),
              approved_at: null,
            },
      )
      .executeTakeFirstOrThrow();

    return { message: null };
  } catch (_e) {
    return { message: '승인/반려에 실패하였습니다' };
  }
}

export async function fetchPointSummary(sn: string) {
  const pointsQuery = kysely.selectFrom('points').where('receiver_id', '=', sn);
  const usedPointsQuery = kysely
    .selectFrom('used_points')
    .where('user_id', '=', sn);

  const [meritData, demeritData, usedMeritData] = await Promise.all([
    pointsQuery
      .where('value', '>', 0)
      .where('status', '=', 'approved')
      .select((eb) => eb.fn.sum<string>('value').as('value'))
      .executeTakeFirst(),
    pointsQuery
      .where('value', '<', 0)
      .where('status', '=', 'approved')
      .select((eb) => eb.fn.sum<string>('value').as('value'))
      .executeTakeFirst(),
    usedPointsQuery
      .where('value', '>', 0)
      .select((eb) => eb.fn.sum<string>('value').as('value'))
      .executeTakeFirst(),
  ]);

  return {
    merit: parseInt(meritData?.value ?? '0', 10),
    demerit: parseInt(demeritData?.value ?? '0', 10),
    usedMerit: parseInt(usedMeritData?.value ?? '0', 10),
  };
}

export async function createPoint({
  value,
  giverId,
  receiverId,
  reason,
  givenAt,
  approverId,
}: {
  value:       number;
  giverId?:    string | null;
  receiverId?: string | null;
  reason:      string;
  givenAt:     Date;
  approverId?: string | null;
}) {
  if (reason.trim() === '') {
    return { message: '상벌점 수여 이유를 작성해주세요' };
  }
  if (value !== Math.round(value)) {
    return { message: '상벌점은 정수여야 합니다' };
  }
  if (value === 0) {
    return { message: '1점 이상이거나 -1점 미만이어야합니다' };
  }

  const { type, sn, permissions } = await currentSoldier();

  if (
    (type === 'enlisted' && giverId == null) ||
    (type === 'nco' && receiverId == null)
  ) {
    return { message: '대상을 입력해주세요' };
  }

  const target = await fetchSoldier(
    type === 'enlisted' ? giverId! : receiverId!,
  );
  if (target == null) {
    return { message: '대상이 존재하지 않습니다' };
  }

  if (type === 'enlisted') {
    if (giverId === sn) {
      return { message: '스스로에게 수여할 수 없습니다' };
    }
    if (!approverId) {
      return { message: '중대장을 선택해주세요' };
    }

    console.log("🔥 Payload to insert:", {
      given_at: givenAt,
      receiver_id: sn,
      giver_id: giverId,
      approver_id: approverId,
      value,
      reason,
      status: 'pending',
    });

    try {
      await kysely
        .insertInto('points')
        .values({
          given_at:    givenAt,
          receiver_id: sn!,
          giver_id:    giverId!,
          approver_id: approverId,
          value,
          reason,
          status: 'pending',
          rejected_reason: null,
          rejected_at:   null,
        } as any)
        .executeTakeFirstOrThrow();

      return { message: null };
    } catch (e) {
      console.error('❌ createPoint error:', e);
      return { message: '알 수 없는 오류가 발생했습니다' };
    }
  }

  if (type === 'nco') {
    const isCommander = hasPermission(permissions, ['Commander']);
    if (!isCommander && !approverId) {
      return { message: '중대장을 선택해주세요' };
    }

    const resolvedApproverId = isCommander ? sn : approverId;

    // 혹시라도 null일 경우를 막기 위한 추가 체크 (방어 코드)
    if (!resolvedApproverId) {
      return { message: '승인자 정보가 누락되었습니다.' };
    }

    try {
      console.log("📦 insert payload", {
        giverId: sn,
        receiverId,
        approverId: resolvedApproverId,
        value,
        reason,
        givenAt,
        status: isCommander ? 'approved' : 'pending',
      });

      await kysely
        .insertInto('points')
        .values({
          given_at: givenAt,
          receiver_id: receiverId!,
          giver_id: sn!,
          approver_id: isCommander ? sn : approverId!,
          value,
          reason,
          status: isCommander ? 'approved' : 'pending',
          approved_at: isCommander ? new Date() : null,
          rejected_reason: null,
          rejected_at: null,
        } as any)
        .executeTakeFirstOrThrow();

      return { message: null };
    } catch (e) {
      console.error('❌ createPoint error:', e);
      return { message: '알 수 없는 오류가 발생했습니다' };
    }
  }

  return { message: '상벌점 수여 권한이 없습니다' };
}

export async function redeemPoint({
  value,
  userId,
  reason,
}: {
  value:  number;
  userId: string;
  reason: string;
}) {
  if (reason.trim() === '') {
    return { message: '상벌점 사용 이유를 작성해주세요' };
  }
  if (value !== Math.round(value)) {
    return { message: '상벌점은 정수여야 합니다' };
  }
  if (value <= 0) {
    return { message: '1점 이상이어야합니다' };
  }

  const { type, sn, permissions } = await currentSoldier();
  if (sn == null) {
    return { message: '로그아웃후 재시도해 주세요' };
  }
  if (type === 'enlisted') {
    return { message: '용사는 상점을 사용할 수 없습니다' };
  }
  if (userId == null) {
    return { message: '대상을 입력해주세요' };
  }

  const target = await fetchSoldier(userId);
  if (target == null) {
    return { message: '대상이 존재하지 않습니다' };
  }
  if (!hasPermission(permissions, ['Admin', 'Commander'])) {
    return { message: '권한이 없습니다' };
  }

  try {
    const [{ total }, { used_points }] = await Promise.all([
      kysely
        .selectFrom('points')
        .where('receiver_id', '=', userId)
        .where('status', '=', 'approved')
        .select(({ fn }) =>
          fn
            .coalesce(fn.sum<string>('points.value'), sql<string>`0`)
            .as('total'),
        )
        .executeTakeFirstOrThrow(),
      kysely
        .selectFrom('used_points')
        .where('user_id', '=', userId)
        .select(({ fn }) =>
          fn
            .coalesce(fn.sum<string>('used_points.value'), sql<string>`0`)
            .as('used_points'),
        )
        .executeTakeFirstOrThrow(),
    ]);

    if (parseInt(total, 10) - parseInt(used_points, 10) < value) {
      return { message: '상점이 부족합니다' };
    }

    await kysely
      .insertInto('used_points')
      .values({
        user_id:     userId,
        recorded_by: sn,
        reason,
        value,
      } as any)
      .executeTakeFirstOrThrow();

    return { message: null };
  } catch (_e) {
    return { message: '알 수 없는 오류가 발생했습니다' };
  }
}

export async function fetchPointTemplates() {
  return kysely.selectFrom('point_templates').selectAll().execute();
}
