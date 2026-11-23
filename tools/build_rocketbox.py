#!/usr/bin/env python3
"""
CalqueLa : préparation des personnages Microsoft Rocketbox (licence MIT) pour le web.

Copie le FBX d'origine et convertit les textures TGA en JPEG/WebP plus légers.
Usage :
  python3 tools/build_rocketbox.py --src chemin/vers/Microsoft-Rocketbox/Assets/Avatars
"""
import argparse
import json
import os
import shutil

import numpy as np
from PIL import Image

CHARACTERS = [
    # (identifiant, dossier, nom affiché, genre)
    ("Sports_Female_01", "Professions/Sports_Female_01", "Léa (maillot de bain)", "female"),
    ("Sports_Male_01", "Professions/Sports_Male_01", "Hugo (maillot de bain)", "male"),
    ("Sports_Female_02", "Professions/Sports_Female_02", "Inès (débardeur)", "female"),
    ("Sports_Male_04", "Professions/Sports_Male_04", "Karim (débardeur)", "male"),
    ("Male_Adult_01", "Adults/Male_Adult_01", "Tom (short)", "male"),
    ("Female_Adult_01", "Adults/Female_Adult_01", "Julie (chemisier)", "female"),
]


def find(textures, suffix):
    for f in textures:
        if f.lower().endswith(suffix):
            return f
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True, help="dossier Assets/Avatars du dépôt Microsoft-Rocketbox")
    ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "..", "frontend", "public", "models"))
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    index = []
    for cid, folder, label, gender in CHARACTERS:
        src = os.path.join(args.src, folder)
        dst = os.path.join(args.out, cid)
        os.makedirs(dst, exist_ok=True)
        shutil.copy(os.path.join(src, "Export", cid + ".fbx"), os.path.join(dst, "model.fbx"))
        tex = os.listdir(os.path.join(src, "Textures"))
        files = {}
        for part in ("body", "head"):
            color = find(tex, f"_{part}_color.tga")
            normal = find(tex, f"_{part}_normal.tga")
            spec = find(tex, f"_{part}_specular.tga")
            im = Image.open(os.path.join(src, "Textures", color)).convert("RGB")
            im.resize((2048, 2048), Image.LANCZOS).save(os.path.join(dst, f"{part}.jpg"), quality=86, optimize=True, progressive=True)
            files[part] = f"{part}.jpg"
            if normal:
                n = Image.open(os.path.join(src, "Textures", normal)).convert("RGB")
                n.resize((1024, 1024), Image.LANCZOS).save(os.path.join(dst, f"{part}_n.jpg"), quality=90, optimize=True)
                files[part + "_n"] = f"{part}_n.jpg"
            if spec:
                s = np.asarray(Image.open(os.path.join(src, "Textures", spec)).convert("L").resize((1024, 1024), Image.LANCZOS), dtype=np.float32) / 255.0
                # carte de brillance → rugosité (canal vert lu par Three.js)
                r = np.clip(0.85 - s * 0.6, 0.3, 0.9)
                Image.fromarray((np.dstack([r, r, r]) * 255).astype(np.uint8)).save(os.path.join(dst, f"{part}_r.jpg"), quality=85)
                files[part + "_r"] = f"{part}_r.jpg"
        op = find(tex, "_opacity_color.tga")
        if op:
            Image.open(os.path.join(src, "Textures", op)).convert("RGBA").resize((1024, 1024), Image.LANCZOS).save(
                os.path.join(dst, "opacity.webp"), quality=90, method=6)
            files["opacity"] = "opacity.webp"
        prev = os.path.join(src, cid + ".png")
        if os.path.exists(prev):
            p = Image.open(prev).convert("RGB")
            w, h = p.size
            p.crop((w // 2 - 230, 0, w // 2 + 230, h)).resize((180, 282), Image.LANCZOS).save(os.path.join(dst, "thumb.jpg"), quality=85)
            files["thumb"] = "thumb.jpg"
        index.append({"id": cid, "label": label, "gender": gender, "files": files})
        print(cid, files)
    with open(os.path.join(args.out, "index.json"), "w") as f:
        json.dump({"source": "Microsoft Rocketbox Avatar Library (MIT) — https://github.com/microsoft/Microsoft-Rocketbox",
                   "characters": index}, f, ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()

# GROGNON
