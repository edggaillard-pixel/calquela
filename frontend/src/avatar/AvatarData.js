// Chargement des données de l'avatar produites par tools/build_avatar.py
// (dérivées des données libres CC0 de MakeHuman).

const TYPES = {
  float32: Float32Array,
  uint16: Uint16Array,
  int16: Int16Array,
  uint8: Uint8Array,
  uint32: Uint32Array,
};

export async function loadAvatarData(baseUrl = './avatar/') {
  const [meta, buffer] = await Promise.all([
    fetch(baseUrl + 'avatar.json').then((r) => {
      if (!r.ok) throw new Error('avatar.json introuvable');
      return r.json();
    }),
    fetch(baseUrl + 'avatar.bin').then((r) => {
      if (!r.ok) throw new Error('avatar.bin introuvable');
      return r.arrayBuffer();
    }),
  ]);

  const section = (name) => {
    const s = meta.sections[name];
    const T = TYPES[s.type];
    return new T(buffer, s.offset, s.count);
  };

  const data = {
    meta,
    counts: meta.counts,
    basePos: section('basePos'),
    quads: section('quads'),
    renderCpu: section('renderCpu'),
    uv: section('uv'),
    index: section('index'),
    skinIndex: section('skinIndex'),
    skinWeight: section('skinWeight'),
    features: section('features'),
    cloth: section('cloth'),
    briefs: section('briefs'),
    top: section('top'),
    scalp: section('scalp'),
    jointVerts: section('jointVerts'),
    jointStart: section('jointStart'),
    eye: {
      count: meta.eye.count,
      scales: meta.eye.scales,
      refs: section('eyeRefs'),
      weights: section('eyeWeights'),
      offsets: section('eyeOffsets'),
      uv: section('eyeUv'),
      index: section('eyeIndex'),
      side: section('eyeSide'),
    },
    bones: meta.bones,
    jointNames: meta.jointNames,
    targets: meta.targets.map((t) => ({
      ...t,
      idx: t.count ? new Uint16Array(buffer, t.idx, t.count) : null,
      delta: t.count ? new Int16Array(buffer, t.delta, t.count * 3) : null,
    })),
  };
  return data;
}

// GROGNON
