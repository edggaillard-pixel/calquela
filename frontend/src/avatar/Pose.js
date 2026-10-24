import * as THREE from 'three';

/**
 * Poses : angles en degrés, mesurés de façon « absolue » pour être lisibles :
 *  - bras.lever : 0° = bras le long du corps, 90° = à l'horizontale, 180° = vers le haut
 *  - bras.avant : balancement vers l'avant (+) ou l'arrière (−)
 *  - coude / genou : 0° = membre tendu
 *  - jambe.ecart : écartement sur le côté, jambe.avant : levée vers l'avant
 */
export const DEFAULT_POSE = {
  armL: { raise: 12, forward: 0 },
  armR: { raise: 12, forward: 0 },
  elbowL: 12,
  elbowR: 12,
  legL: { side: 4, forward: 0 },
  legR: { side: 4, forward: 0 },
  kneeL: 0,
  kneeR: 0,
  head: { turn: 0, tilt: 0 },
  torso: { turn: 0, bend: 0 },
};

export const POSE_PRESETS = [
  { id: 'repos', label: 'Repos', pose: DEFAULT_POSE },
  {
    id: 'apose',
    label: 'Pose A',
    pose: { ...DEFAULT_POSE, armL: { raise: 45, forward: 0 }, armR: { raise: 45, forward: 0 }, elbowL: 0, elbowR: 0, legL: { side: 8, forward: 0 }, legR: { side: 8, forward: 0 } },
  },
  {
    id: 'tpose',
    label: 'Bras en croix',
    pose: { ...DEFAULT_POSE, armL: { raise: 90, forward: 0 }, armR: { raise: 90, forward: 0 }, elbowL: 0, elbowR: 0 },
  },
  {
    id: 'haut',
    label: 'Bras levés',
    pose: { ...DEFAULT_POSE, armL: { raise: 165, forward: 0 }, armR: { raise: 165, forward: 0 }, elbowL: 10, elbowR: 10 },
  },
  {
    id: 'biceps',
    label: 'Biceps',
    pose: { ...DEFAULT_POSE, armL: { raise: 90, forward: 0 }, armR: { raise: 90, forward: 0 }, elbowL: 110, elbowR: 110 },
  },
  {
    id: 'hanches',
    label: 'Mains aux hanches',
    pose: { ...DEFAULT_POSE, armL: { raise: 40, forward: -10 }, armR: { raise: 40, forward: -10 }, elbowL: 95, elbowR: 95 },
  },
  {
    id: 'marche',
    label: 'Marche',
    pose: {
      ...DEFAULT_POSE,
      armL: { raise: 10, forward: -22 }, armR: { raise: 10, forward: 22 }, elbowL: 15, elbowR: 30,
      legL: { side: 3, forward: 25 }, legR: { side: 3, forward: -15 }, kneeL: 15, kneeR: 30,
    },
  },
  {
    id: 'genou',
    label: 'Genou levé',
    pose: { ...DEFAULT_POSE, legL: { side: 6, forward: 85 }, kneeL: 90 },
  },
];

const X = new THREE.Vector3(1, 0, 0);
const Y = new THREE.Vector3(0, 1, 0);
const Z = new THREE.Vector3(0, 0, 1);
const DEG = Math.PI / 180;

function rotateToward(dir, toward, angleDeg) {
  const axis = new THREE.Vector3().crossVectors(dir, toward);
  if (axis.lengthSq() < 1e-8) return new THREE.Quaternion();
  return new THREE.Quaternion().setFromAxisAngle(axis.normalize(), angleDeg * DEG);
}

/** Angle (degrés) de `dir` par rapport à la verticale descendante, dans le plan frontal. */
function frontalAngle(dir, outward) {
  return Math.atan2(dir.x * outward, -dir.y) / DEG;
}

/** Angle entre deux segments (0 = alignés). */
function bendAngle(a, b) {
  return a.angleTo(b) / DEG;
}

/**
 * Calcule la rotation de chaque os. Les os sont au repos sans rotation
 * (repère monde), on peut donc exprimer chaque rotation dans le repère monde
 * de la pose de repos.
 */
export function computePoseQuaternions(avatar, pose) {
  const p = { ...DEFAULT_POSE, ...pose };
  const h = (n) => avatar.boneHead(n);
  const out = {};

  for (const side of ['L', 'R']) {
    const outward = side === 'L' ? 1 : -1;
    const arm = p['arm' + side];
    const elbow = p['elbow' + side];
    const shoulder = h('upperarm01.' + side);
    const elbowP = h('lowerarm01.' + side);
    const wrist = h('wrist.' + side);
    const d = elbowP.clone().sub(shoulder).normalize();
    const f = wrist.clone().sub(elbowP).normalize();

    // Bras : écart dans le plan frontal, puis balancement avant/arrière
    const rest = frontalAngle(d, outward);
    const qRaise = new THREE.Quaternion().setFromAxisAngle(Z, (arm.raise - rest) * DEG * outward);
    const d1 = d.clone().applyQuaternion(qRaise);
    const qFwd = rotateToward(d1, Z, arm.forward);
    out['upperarm01.' + side] = qFwd.multiply(qRaise);

    // Coude : rotation dans le plan du pli existant
    const restBend = bendAngle(d, f);
    const axis = new THREE.Vector3().crossVectors(d, f).normalize();
    out['lowerarm01.' + side] = new THREE.Quaternion().setFromAxisAngle(axis, (elbow - restBend) * DEG);

    // Jambe
    const leg = p['leg' + side];
    const knee = p['knee' + side];
    const hip = h('upperleg01.' + side);
    const kneeP = h('lowerleg01.' + side);
    const ankle = h('foot.' + side);
    const t = kneeP.clone().sub(hip).normalize();
    const s = ankle.clone().sub(kneeP).normalize();
    const restSide = frontalAngle(t, outward);
    const qSide = new THREE.Quaternion().setFromAxisAngle(Z, (leg.side - restSide) * DEG * outward);
    const t1 = t.clone().applyQuaternion(qSide);
    const qLegFwd = rotateToward(t1, Z, leg.forward);
    out['upperleg01.' + side] = qLegFwd.multiply(qSide);

    const restKnee = bendAngle(t, s);
    const kneeAxis = new THREE.Vector3().crossVectors(s, Z.clone().negate());
    if (kneeAxis.lengthSq() > 1e-8) {
      out['lowerleg01.' + side] = new THREE.Quaternion().setFromAxisAngle(kneeAxis.normalize(), (knee - restKnee) * DEG);
    }
  }

  // Tête et buste
  const qHead = new THREE.Quaternion().setFromEuler(new THREE.Euler(p.head.tilt * DEG, p.head.turn * DEG, 0, 'YXZ'));
  out.neck01 = qHead;
  const qTorso = new THREE.Quaternion().setFromEuler(new THREE.Euler(p.torso.bend * DEG, p.torso.turn * DEG, 0, 'YXZ'));
  out.spine03 = qTorso;
  return out;
}

export function clonePose(p) {
  return JSON.parse(JSON.stringify(p));
}

// GROGNON
