#!/usr/bin/env python3
"""
CalqueLa — construction des données de l'avatar 3D.

Lit les données MakeHuman (CC0) et produit deux fichiers chargés par le site :
  frontend/public/avatar/avatar.json  (métadonnées)
  frontend/public/avatar/avatar.bin   (tableaux binaires little-endian)
  frontend/public/avatar/eye.jpg      (texture des yeux)

Le navigateur refait ensuite ce que fait MakeHuman : il combine les cibles
(morphs) selon les curseurs, recalcule les articulations du squelette et
ajuste les yeux. Les coordonnées sont en décimètres (unité MakeHuman).

Usage :
  python3 tools/build_avatar.py --mh /chemin/vers/makehuman/makehuman/data
"""
import argparse
import collections
import json
import math
import os
import re
import struct

import numpy as np
from PIL import Image, ImageFilter

AGE = "young"

# Modèles du pack « MakeHuman system assets » (CC0) : (identifiant, type, dossier)
PROXIES = [
    ("eyebrows", "eyebrows", "eyebrows/eyebrow001"),
    ("eyelashes", "eyelashes", "eyelashes/eyelashes01"),
    ("short04", "hair", "hair/short04"),
    ("short02", "hair", "hair/short02"),
    ("short03", "hair", "hair/short03"),
    ("bob01", "hair", "hair/bob01"),
    ("long01", "hair", "hair/long01"),
    ("ponytail01", "hair", "hair/ponytail01"),
    ("braid01", "hair", "hair/braid01"),
    ("afro01", "hair", "hair/afro01"),
]
# Textures de peau photographiques (CC0)
SKINS = [
    ("female-light", "young_caucasian_female"),
    ("female-medium", "young_asian_female"),
    ("female-dark", "young_african_female"),
    ("male-light", "young_caucasian_male"),
    ("male-medium", "young_asian_male"),
    ("male-dark", "young_african_male"),
]
GENDERS = ["female", "male"]
LEVELS = ["min", "average", "max"]


# ---------------------------------------------------------------- lecture
def read_obj(path):
    V, VT, faces = [], [], collections.defaultdict(list)
    group = None
    with open(path) as f:
        for line in f:
            if line.startswith("v "):
                V.append([float(x) for x in line.split()[1:4]])
            elif line.startswith("vt "):
                VT.append([float(x) for x in line.split()[1:3]])
            elif line.startswith("g "):
                group = line.split()[1]
            elif line.startswith("f "):
                face = []
                for p in line.split()[1:]:
                    parts = p.split("/")
                    vi = int(parts[0]) - 1
                    ti = int(parts[1]) - 1 if len(parts) > 1 and parts[1] else -1
                    face.append((vi, ti))
                faces[group].append(face)
    return np.array(V, dtype=np.float64), np.array(VT, dtype=np.float64), faces


def read_target(path, nverts):
    """Retourne un tableau dense (nverts, 3) des déplacements."""
    d = np.zeros((nverts, 3), dtype=np.float64)
    if not os.path.exists(path):
        raise FileNotFoundError(path)
    with open(path) as f:
        for line in f:
            if not line or not line[0].isdigit():
                continue
            p = line.split()
            d[int(p[0])] = (float(p[1]), float(p[2]), float(p[3]))
    return d


def read_mhclo(path):
    refs, weights, offsets, scales = [], [], [], [None, None, None]
    in_verts = False
    with open(path) as f:
        for line in f:
            w = line.split()
            if not w or w[0].startswith("#"):
                continue
            if w[0] in ("x_scale", "y_scale", "z_scale"):
                scales["xyz".index(w[0][0])] = (int(w[1]), int(w[2]), float(w[3]))
            elif w[0] == "verts":
                in_verts = True
            elif in_verts and not w[0][0].isdigit():
                # mot-clé glissé dans le bloc des sommets (ex. « material ») : ignoré
                if w[0] in ("delete_verts",):
                    in_verts = False
                continue
            elif in_verts:
                if len(w) == 1 and w[0].isdigit():
                    refs.append([int(w[0])] * 3)
                    weights.append([1.0, 0.0, 0.0])
                    offsets.append([0.0, 0.0, 0.0])
                elif len(w) >= 9:
                    refs.append([int(w[0]), int(w[1]), int(w[2])])
                    weights.append([float(w[3]), float(w[4]), float(w[5])])
                    offsets.append([float(w[6]), float(w[7]), float(w[8])])
                else:
                    in_verts = False
    return np.array(refs), np.array(weights), np.array(offsets), scales


# ---------------------------------------------------------------- binaire
class Blob:
    def __init__(self):
        self.buf = bytearray()
        self.sections = {}

    def add(self, name, arr, dtype):
        arr = np.ascontiguousarray(arr, dtype=dtype)
        while len(self.buf) % 4:
            self.buf.append(0)
        self.sections[name] = {
            "offset": len(self.buf),
            "count": int(arr.size),
            "type": np.dtype(dtype).name,
        }
        self.buf += arr.tobytes()
        return self.sections[name]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mh", required=True, help="dossier makehuman/data")
    ap.add_argument("--assets", required=True, help="dossier du pack « MakeHuman system assets » (CC0)")
    ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "..", "frontend", "public", "avatar"))
    args = ap.parse_args()
    MH = args.mh
    os.makedirs(args.out, exist_ok=True)

    V, VT, faces = read_obj(os.path.join(MH, "3dobjs", "base.obj"))
    NV = len(V)
    print("sommets de base :", NV)

    skel = json.load(open(os.path.join(MH, "rigs", "default.mhskel")))
    wfile = json.load(open(os.path.join(MH, "rigs", "default_weights.mhw")))["weights"]
    eye_refs, eye_w, eye_off, eye_scales = read_mhclo(os.path.join(MH, "eyes", "high-poly", "high-poly.mhclo"))
    EV, EVT, efaces = read_obj(os.path.join(MH, "eyes", "high-poly", "high-poly.obj"))

    # Vrais modèles 3D ajustés au corps (pack « MakeHuman system assets », CC0)
    A = args.assets
    proxy_src = {}
    for pid, kind, folder in PROXIES:
        d = os.path.join(A, folder)
        mhclo = [f for f in os.listdir(d) if f.endswith(".mhclo")][0]
        objf = [f for f in os.listdir(d) if f.endswith(".obj")][0]
        refs, w, off, scales = read_mhclo(os.path.join(d, mhclo))
        PV, PVT, pfaces = read_obj(os.path.join(d, objf))
        n = len(PV)
        proxy_src[pid] = (kind, d, refs[:n], w[:n], off[:n], scales, PVT, pfaces)

    # ---------------------------------------------------- sommets "CPU"
    # Corps + sommets d'aide nécessaires (articulations, ajustement des yeux).
    body_faces = faces["body"]
    body_verts = sorted({vi for f in body_faces for vi, _ in f})
    assert body_verts == list(range(len(body_verts))), "le corps doit occuper les premiers sommets"
    NB = len(body_verts)
    needed = set(range(NB))
    for jv in skel["joints"].values():
        needed.update(jv)
    needed.update(eye_refs.flatten().tolist())
    for s in eye_scales:
        if s:
            needed.update(s[:2])
    for kind, d, refs, w, off, scales, PVT, pfaces in proxy_src.values():
        needed.update(refs.flatten().tolist())
        for s in scales:
            needed.update(s[:2])
    cpu = sorted(needed)
    remap = -np.ones(NV, dtype=np.int64)
    remap[cpu] = np.arange(len(cpu))
    NC = len(cpu)
    print("sommets CPU :", NC, "(corps", NB, ")")

    # ---------------------------------------------------- maillage de rendu
    pair_index = {}
    render_cpu, render_uv, tris = [], [], []
    for f in body_faces:
        ids = []
        for vi, ti in f:
            key = (vi, ti)
            if key not in pair_index:
                pair_index[key] = len(render_cpu)
                render_cpu.append(remap[vi])
                render_uv.append(VT[ti])
            ids.append(pair_index[key])
        tris.append((ids[0], ids[1], ids[2]))
        if len(ids) == 4:
            tris.append((ids[0], ids[2], ids[3]))
    render_cpu = np.array(render_cpu)
    render_uv = np.array(render_uv)
    tris = np.array(tris)
    NR = len(render_cpu)
    print("sommets de rendu :", NR, "triangles :", len(tris))
    # quads du corps en indices CPU (pour des normales sans couture)
    cpu_quads = np.array([[remap[vi] for vi, _ in f] for f in body_faces])

    # ---------------------------------------------------- cibles (morphs)
    T = os.path.join(MH, "targets")

    def tgt(rel):
        return read_target(os.path.join(T, rel), NV)

    targets = []  # (nom, facteurs, dense)
    for g in GENDERS:
        eth = sum(tgt(f"macrodetails/{r}-{g}-{AGE}.target") for r in ("african", "asian", "caucasian")) / 3.0
        for m in LEVELS:
            for w in LEVELS:
                d = tgt(f"macrodetails/universal-{g}-{AGE}-{m}muscle-{w}weight.target") + eth
                targets.append((f"universal-{g}-{m}-{w}", {"gender": g, "muscle": m, "weight": w}, d))
        # taille : on garde la musculature moyenne (approximation légère)
        for w in LEVELS:
            for h in ("min", "max"):
                d = tgt(f"macrodetails/height/{g}-{AGE}-averagemuscle-{w}weight-{h}height.target")
                targets.append((f"height-{g}-{w}-{h}", {"gender": g, "weight": w, "height": h}, d))
        for p in ("uncommon", "ideal"):
            d = tgt(f"macrodetails/proportions/{g}-{AGE}-averagemuscle-averageweight-{p}proportions.target")
            targets.append((f"proportions-{g}-{p}", {"gender": g, "proportions": p}, d))
    for c in ("min", "max"):
        d = tgt(f"breast/female-{AGE}-averagemuscle-averageweight-{c}cup-averagefirmness.target")
        targets.append((f"breast-female-{c}", {"gender": "female", "cup": c}, d))

    blob = Blob()
    tmeta = []
    total = 0
    for name, factors, dense in targets:
        sub = dense[cpu]
        mag = np.abs(sub).max(axis=1)
        idx = np.nonzero(mag > 2e-4)[0]  # < 0,02 mm ignoré
        if len(idx) == 0:
            tmeta.append({"name": name, "factors": factors, "count": 0})
            continue
        vals = sub[idx]
        scale = float(np.abs(vals).max() / 32767.0)
        q = np.round(vals / scale).astype(np.int16)
        s1 = blob.add(f"t_{name}_i", idx, np.uint16)
        s2 = blob.add(f"t_{name}_d", q, np.int16)
        tmeta.append({"name": name, "factors": factors, "count": int(len(idx)),
                      "idx": s1["offset"], "delta": s2["offset"], "scale": scale})
        total += len(idx)
    print("cibles :", len(targets), "entrées :", total)

    # ---------------------------------------------------- squelette
    bones = skel["bones"]
    order = []
    seen = set()

    def visit(b):
        if b in seen:
            return
        p = bones[b]["parent"]
        if p:
            visit(p)
        seen.add(b)
        order.append(b)

    for b in sorted(bones):
        visit(b)
    bidx = {b: i for i, b in enumerate(order)}
    joint_names = sorted(skel["joints"])
    jidx = {j: i for i, j in enumerate(joint_names)}
    joint_flat, joint_start = [], []
    for j in joint_names:
        joint_start.append(len(joint_flat))
        joint_flat.extend(int(remap[v]) for v in skel["joints"][j])
    joint_start.append(len(joint_flat))
    bone_meta = [{"name": b, "parent": bidx[bones[b]["parent"]] if bones[b]["parent"] else -1,
                  "head": jidx[bones[b]["head"]], "tail": jidx[bones[b]["tail"]]} for b in order]

    # poids : 4 os max par sommet de rendu
    per_vert = collections.defaultdict(list)
    for bname, lst in wfile.items():
        for vi, w in lst:
            per_vert[vi].append((w, bidx[bname]))
    head_bone = bidx["head"]
    skin_i = np.zeros((NR, 4), dtype=np.uint8)
    skin_w = np.zeros((NR, 4), dtype=np.uint8)
    cpu_to_base = np.array(cpu)
    for r in range(NR):
        base_v = cpu_to_base[render_cpu[r]]
        lst = sorted(per_vert.get(base_v, [(1.0, head_bone)]), reverse=True)[:4]
        ws = np.array([w for w, _ in lst])
        ws = ws / ws.sum()
        q = np.floor(ws * 255).astype(int)
        q[0] += 255 - q.sum()
        for k, (w, b) in enumerate(lst):
            skin_i[r, k] = b
            skin_w[r, k] = q[k]

    # ---------------------------------------------------- masques de détails
    # Lèvres, sourcils, aréoles : les sommets déplacés par les cibles dédiées.
    def mask_from(rel_list):
        m = np.zeros(NV)
        for rel in rel_list:
            d = np.linalg.norm(tgt(rel), axis=1)
            m = np.maximum(m, d)
        return m[body_verts]

    lips = mask_from(["mouth/mouth-upperlip-volume-incr.target", "mouth/mouth-lowerlip-volume-incr.target"])
    nipples = mask_from(["breast/nipple-size-incr.target"])

    def norm(m, lo, hi):
        mx = m.max() if m.max() > 0 else 1
        x = np.clip((m / mx - lo) / (hi - lo), 0, 1)
        return x * x * (3 - 2 * x)

    def smooth(x):
        x = np.clip(x, 0, 1)
        return x * x * (3 - 2 * x)

    lips_n, nip_n = norm(lips, 0.15, 0.6), norm(nipples, 0.25, 0.75)

    B = V[:NB]
    x, y, z = B[:, 0], B[:, 1], B[:, 2]

    # sourcils : arc dessiné au-dessus de chaque oeil (géométrie neutre)
    eye = V[skel["joints"]["eye.L____head"]].mean(0)
    ax = np.abs(x)
    t = (ax - 0.12) / 0.62
    tc = np.clip(t, 0, 1)
    yc = eye[1] + 0.155 + 0.05 * np.sin(np.pi * tc * 0.85) - 0.05 * tc
    half = 0.045 * (1 - 0.55 * tc)
    brows_n = smooth((half - np.abs(y - yc)) / 0.025) * smooth(t / 0.08) * smooth((1 - t) / 0.12) * (z > eye[2] - 0.35)

    # cuir chevelu : au-dessus d'une ligne d'implantation qui descend vers la nuque
    head_w = np.zeros(NB)
    for vi, w in wfile["head"]:
        if vi < NB:
            head_w[vi] = w
    t = np.clip((z - (-0.1)) / (1.25 - (-0.1)), 0, 1)
    t = t * t * (3 - 2 * t)
    hairline = 6.75 * (1 - t) + 7.98 * t
    temple = (np.abs(x) > 0.95) & (z > 0.35)
    hairline = np.where(temple, np.maximum(hairline, 7.55), hairline)
    ear = (np.abs(x) > 1.12) & (y > 6.75) & (y < 7.62) & (z > -0.45) & (z < 0.6)
    scalp = (head_w > 0.5) & (y > hairline) & ~ear
    scalp_soft = np.clip((y - hairline) / 0.12, 0, 1) * (head_w > 0.5) * (~ear)

    feat = np.zeros((NR, 4), dtype=np.uint8)
    rb = cpu_to_base[render_cpu]
    feat[:, 0] = np.round(lips_n[rb] * 255)
    feat[:, 1] = np.round(brows_n[rb] * 255)
    feat[:, 2] = np.round(nip_n[rb] * 255)
    feat[:, 3] = np.round(scalp_soft[rb] * 255)

    # sous-vêtements : champ continu (positif à l'intérieur, en dm), le shader
    # coupe à 0 : les bords suivent une courbe lisse et non les faces.
    arms = np.zeros(NB, dtype=bool)
    for bname, lst in wfile.items():
        if re.match(r"^(upperarm|lowerarm|wrist|finger|metacarpal)", bname):
            for vi, w in lst:
                if vi < NB and w > 0.5:
                    arms[vi] = True
    front = z > 0.1
    waist = np.where(front, 0.95, 1.08)
    leg = -0.80 + 1.25 * smooth((ax - 0.10) / 1.55) ** 1.2
    leg = np.where(front, leg, leg - 0.28 + 0.1 * smooth((ax - 0.6) / 1.0))
    briefs_f = np.minimum.reduce([waist - y, y - leg, 2.05 - ax, y + 1.4]) - 1.0 * arms
    band_top = 4.72 - 0.10 * smooth((ax - 0.2) / 1.2)
    band = np.minimum.reduce([y - 3.58, band_top - y, 1.66 - ax])
    neckline = np.where(front & (y > 4.4), 0.18 * smooth(1 - ax / 0.45), 0)  # petit décolleté
    band = band - neckline
    strap_c = 0.82
    straps = np.minimum.reduce([0.13 - np.abs(ax - strap_c), y - 4.5, 5.78 - y])
    top_f = np.maximum(band, straps) - 1.0 * arms

    def cloth_val(f):
        return np.clip(0.5 + f / 0.8, 0, 1)

    cloth = np.zeros((NR, 2), dtype=np.uint8)
    cloth[:, 0] = np.round(cloth_val(briefs_f)[rb] * 255)
    cloth[:, 1] = np.round(cloth_val(top_f)[rb] * 255)

    def face_subset(field):
        sel = []
        for ti, tri in enumerate(tris):
            if max(field[cpu_to_base[render_cpu[k]]] for k in tri) > -0.02:
                sel.append(ti)
        return tris[sel].flatten()

    briefs = face_subset(briefs_f)
    top = face_subset(top_f)
    scalp_tris = []
    for a, b2, c in tris:
        bv = [cpu_to_base[render_cpu[k]] for k in (a, b2, c)]
        if all(scalp[v] for v in bv):
            scalp_tris.append((a, b2, c))
    scalp_tris = np.array(scalp_tris).flatten()
    print("slip :", len(briefs) // 3, "haut :", len(top) // 3, "cuir chevelu :", len(scalp_tris) // 3)

    # ---------------------------------------------------- yeux
    eye_pairs, eye_pos_idx, eye_uv, eye_tris = {}, [], [], []
    for grp, flist in efaces.items():
        for f in flist:
            ids = []
            for vi, ti in f:
                k = (vi, ti)
                if k not in eye_pairs:
                    eye_pairs[k] = len(eye_pos_idx)
                    eye_pos_idx.append(vi)
                    eye_uv.append(EVT[ti])
                ids.append(eye_pairs[k])
            eye_tris.append(ids[:3])
            if len(ids) == 4:
                eye_tris.append([ids[0], ids[2], ids[3]])
    eye_pos_idx = np.array(eye_pos_idx)
    e_refs = remap[eye_refs[eye_pos_idx]]
    assert (e_refs >= 0).all()
    e_w = eye_w[eye_pos_idx]
    e_off = eye_off[eye_pos_idx]
    e_scales = [[int(remap[s[0]]), int(remap[s[1]]), s[2]] for s in eye_scales]
    # côté de chaque sommet de l'œil (x > 0 : œil gauche du personnage)
    e_center = (V[eye_refs[eye_pos_idx]] * e_w[:, :, None]).sum(1)
    e_side = (e_center[:, 0] > 0).astype(np.uint8)

    # la cornée utilise une zone transparente de la texture : on garde l'alpha
    img = Image.open(os.path.join(MH, "eyes", "materials", "brown_eye.png")).convert("RGBA")
    img.resize((512, 512), Image.LANCZOS).save(os.path.join(args.out, "eye.png"), optimize=True)

    S = {}
    # ---------------------------------------------------- vrais modèles (cheveux, sourcils, cils)
    proxy_meta = {}
    tex_dir = os.path.join(args.out, "textures")
    os.makedirs(tex_dir, exist_ok=True)
    for pid, (kind, d, refs, w, off, scales, PVT, pfaces) in proxy_src.items():
        pairs, pos_idx, uvs, ptris = {}, [], [], []
        for flist in pfaces.values():
            for f in flist:
                ids = []
                for vi, ti in f:
                    k = (vi, ti)
                    if k not in pairs:
                        pairs[k] = len(pos_idx)
                        pos_idx.append(vi)
                        uvs.append(PVT[ti] if ti >= 0 else (0.0, 0.0))
                    ids.append(pairs[k])
                ptris.append(ids[:3])
                if len(ids) == 4:
                    ptris.append([ids[0], ids[2], ids[3]])
        pos_idx = np.array(pos_idx)
        p_refs = remap[refs[pos_idx]]
        assert (p_refs >= 0).all(), pid
        p_w = w[pos_idx]
        p_off = off[pos_idx]
        # poids de peau : mélange de ceux des 3 sommets de référence
        si = np.zeros((len(pos_idx), 4), dtype=np.uint8)
        sw = np.zeros((len(pos_idx), 4), dtype=np.uint8)
        for i in range(len(pos_idx)):
            acc = collections.defaultdict(float)
            for j in range(3):
                bw = p_w[i, j]
                if bw <= 0:
                    continue
                for wt, b in per_vert.get(int(refs[pos_idx[i], j]), [(1.0, head_bone)]):
                    acc[b] += wt * bw
            top4 = sorted(((v, b) for b, v in acc.items()), reverse=True)[:4] or [(1.0, head_bone)]
            ws = np.array([v for v, _ in top4])
            ws = ws / ws.sum()
            q = np.floor(ws * 255).astype(int)
            q[0] += 255 - q.sum()
            for k, (v, b) in enumerate(top4):
                si[i, k] = b
                sw[i, k] = q[k]
        pre = "p_" + pid + "_"
        S[pre + "refs"] = blob.add(pre + "refs", p_refs, np.uint16)
        S[pre + "w"] = blob.add(pre + "w", p_w.astype(np.float32), np.float32)
        S[pre + "off"] = blob.add(pre + "off", p_off.astype(np.float32), np.float32)
        S[pre + "uv"] = blob.add(pre + "uv", np.array(uvs, dtype=np.float32), np.float32)
        S[pre + "index"] = blob.add(pre + "index", np.array(ptris), np.uint16 if len(pos_idx) < 65536 else np.uint32)
        S[pre + "si"] = blob.add(pre + "si", si, np.uint8)
        S[pre + "sw"] = blob.add(pre + "sw", sw, np.uint8)
        # texture : niveaux de gris normalisés (teintée dans le navigateur) + transparence
        png = sorted(f for f in os.listdir(d) if f.endswith(".png") and "normal" not in f)[0]
        img = Image.open(os.path.join(d, png)).convert("RGBA")
        size = 1024 if kind == "hair" else 512
        img = img.resize((size, size), Image.LANCZOS)
        arr = np.asarray(img).astype(np.float32)
        lum = arr[..., :3] @ np.array([0.299, 0.587, 0.114])
        alpha = arr[..., 3] / 255.0
        mask = alpha > 0.5
        ref = np.percentile(lum[mask], 92) if mask.any() else 255
        lum = np.clip(lum / max(ref, 1), 0, 1)
        # Les zones transparentes des textures d'origine sont souvent blanches :
        # on y propage la couleur des mèches voisines (sinon liseré clair au bord).
        wimg = Image.fromarray((alpha * 255).astype(np.uint8))
        limg = Image.fromarray((lum * alpha * 255).astype(np.uint8))
        bl = np.zeros_like(lum)
        bw = np.zeros_like(lum)
        for r in (2, 6, 16):
            bl += np.asarray(limg.filter(ImageFilter.GaussianBlur(r)), dtype=np.float32) / 255.0
            bw += np.asarray(wimg.filter(ImageFilter.GaussianBlur(r)), dtype=np.float32) / 255.0
        fill = np.where(bw > 1e-3, bl / np.maximum(bw, 1e-3), 0.6)
        lum = np.where(alpha > 0.9, lum, fill)
        # contraste adouci : les cheveux clairs ne deviennent pas tachetés
        g = np.clip((0.35 + 0.65 * lum ** 0.75) * 235, 0, 255)
        out = np.dstack([g, g, g, arr[..., 3]]).astype(np.uint8)
        Image.fromarray(out, "RGBA").save(os.path.join(tex_dir, pid + ".webp"), quality=88, method=6)
        proxy_meta[pid] = {"kind": kind, "count": int(len(pos_idx)), "tris": int(len(ptris)),
                           "scales": [[int(remap[s[0]]), int(remap[s[1]]), s[2]] for s in scales],
                           "texture": "textures/" + pid + ".webp"}
        print("modèle", pid, len(pos_idx), "sommets")

    # ---------------------------------------------------- textures de peau (photos)
    skins_meta = {}
    sk_dir = os.path.join(args.out, "skins")
    os.makedirs(sk_dir, exist_ok=True)
    for sid, folder in SKINS:
        d = os.path.join(A, "skins", folder)
        png = [f for f in os.listdir(d) if f.endswith(".png")][0]
        img = Image.open(os.path.join(d, png)).convert("RGB")
        arr = np.asarray(img)
        h, w = arr.shape[:2]
        # couleur moyenne de la peau, mesurée aux coordonnées UV du corps
        u = np.clip((render_uv[:, 0] * (w - 1)).astype(int), 0, w - 1)
        v = np.clip(((1 - render_uv[:, 1]) * (h - 1)).astype(int), 0, h - 1)
        mean = arr[v, u].astype(np.float64).mean(0) / 255.0
        img.resize((2048, 2048), Image.LANCZOS).save(os.path.join(sk_dir, sid + ".jpg"), quality=86, optimize=True, progressive=True)
        skins_meta[sid] = {"file": "skins/" + sid + ".jpg", "mean": [round(float(x), 4) for x in mean]}
        print("peau", sid, np.round(mean, 3))

    # ---------------------------------------------------- écriture
    meta = {
        "format": "calquela-avatar", "version": 1, "units": "dm",
        "source": "MakeHuman 1.x data (CC0) — https://www.makehumancommunity.org",
        "counts": {"cpu": NC, "body": NB, "render": NR, "tris": int(len(tris))},
        "targets": tmeta, "bones": bone_meta, "jointNames": joint_names,
        "eye": {"count": int(len(eye_pos_idx)), "scales": e_scales},
    }
    S["basePos"] = blob.add("basePos", V[cpu].astype(np.float32), np.float32)
    S["quads"] = blob.add("quads", cpu_quads, np.uint16)
    S["renderCpu"] = blob.add("renderCpu", render_cpu, np.uint16)
    S["uv"] = blob.add("uv", render_uv.astype(np.float32), np.float32)
    S["index"] = blob.add("index", tris, np.uint16)
    S["skinIndex"] = blob.add("skinIndex", skin_i, np.uint8)
    S["skinWeight"] = blob.add("skinWeight", skin_w, np.uint8)
    S["features"] = blob.add("features", feat, np.uint8)
    S["cloth"] = blob.add("cloth", cloth, np.uint8)
    S["briefs"] = blob.add("briefs", briefs, np.uint16)
    S["top"] = blob.add("top", top, np.uint16)
    S["scalp"] = blob.add("scalp", scalp_tris, np.uint16)
    S["jointVerts"] = blob.add("jointVerts", np.array(joint_flat), np.uint16)
    S["jointStart"] = blob.add("jointStart", np.array(joint_start), np.uint32)
    S["eyeRefs"] = blob.add("eyeRefs", e_refs, np.uint16)
    S["eyeWeights"] = blob.add("eyeWeights", e_w.astype(np.float32), np.float32)
    S["eyeOffsets"] = blob.add("eyeOffsets", e_off.astype(np.float32), np.float32)
    S["eyeUv"] = blob.add("eyeUv", np.array(eye_uv, dtype=np.float32), np.float32)
    S["eyeIndex"] = blob.add("eyeIndex", np.array(eye_tris), np.uint16)
    S["eyeSide"] = blob.add("eyeSide", e_side, np.uint8)
    meta["proxies"] = proxy_meta
    meta["skins"] = skins_meta
    meta["sections"] = S
    with open(os.path.join(args.out, "avatar.bin"), "wb") as f:
        f.write(blob.buf)
    with open(os.path.join(args.out, "avatar.json"), "w") as f:
        json.dump(meta, f, separators=(",", ":"))
    print("avatar.bin :", round(len(blob.buf) / 1e6, 2), "Mo")


if __name__ == "__main__":
    main()

# GROGNON
