package fr.calquela.tattoo;

import java.awt.image.BufferedImage;
import java.util.ArrayDeque;

/**
 * Isole le motif d'un tatouage à partir d'une image (dessin d'artiste, flash
 * photographié sur papier, image numérique...).
 *
 * <p>Étapes :
 * <ol>
 *   <li>Estimation du fond « local » (papier, éclairage inégal) par une
 *       enveloppe morphologique calculée sur une version réduite de l'image ;</li>
 *   <li>Normalisation de chaque pixel par ce fond (flat-field) ;</li>
 *   <li>Calcul d'une « présence d'encre » puis d'une transparence progressive ;</li>
 *   <li>Récupération de la couleur réelle de l'encre (démélange avec le fond) ;</li>
 *   <li>Suppression des petites taches isolées et recadrage.</li>
 * </ol>
 *
 * <p>Classe en Java pur (aucune dépendance) : elle est testable seule et
 * réutilisable hors de Spring.
 */
public final class TattooProcessor {

    /** Taille maximale (plus grand côté) de l'image traitée. */
    public static final int MAX_SIDE = 2048;

    /** Résultat : image ARGB recadrée + quelques informations. */
    public record Result(BufferedImage image, boolean darkBackground, boolean hadTransparency, int keptPixels) { }

    public Result process(BufferedImage input, ProcessingOptions opt) {
        BufferedImage src = limitSize(input);
        int w = src.getWidth();
        int h = src.getHeight();
        int n = w * h;

        float[] r = new float[n];
        float[] g = new float[n];
        float[] b = new float[n];
        float[] srcAlpha = new float[n];
        int transparent = 0;
        int[] argb = src.getRGB(0, 0, w, h, null, 0, w);
        for (int i = 0; i < n; i++) {
            int p = argb[i];
            srcAlpha[i] = ((p >>> 24) & 0xFF) / 255f;
            r[i] = ((p >> 16) & 0xFF) / 255f;
            g[i] = ((p >> 8) & 0xFF) / 255f;
            b[i] = (p & 0xFF) / 255f;
            if (srcAlpha[i] < 0.98f) {
                transparent++;
            }
        }
        boolean hadTransparency = src.getColorModel().hasAlpha() && transparent > n * 0.02;

        float[] alpha = new float[n];
        float[] outR = new float[n];
        float[] outG = new float[n];
        float[] outB = new float[n];
        boolean dark = false;

        float t0 = 0.05f + opt.tolerance() * 0.40f;
        float soft = 0.03f + opt.softness() * 0.30f;

        if (hadTransparency) {
            // L'image est déjà détourée : on garde sa transparence.
            for (int i = 0; i < n; i++) {
                float a = srcAlpha[i];
                if (opt.mode() == ProcessingOptions.Mode.BLACK) {
                    float darkness = 1f - Math.max(r[i], Math.max(g[i], b[i]));
                    a *= smoothstep(t0, t0 + soft, darkness);
                }
                alpha[i] = a;
                outR[i] = r[i];
                outG[i] = g[i];
                outB[i] = b[i];
            }
        } else {
            dark = borderLuminance(r, g, b, w, h) < 0.35f;
            float[][] bg = estimateBackground(new float[][] {r, g, b}, w, h, dark);
            for (int i = 0; i < n; i++) {
                float rr;
                float rg;
                float rb;
                if (!dark) {
                    rr = clamp01(r[i] / Math.max(bg[0][i], 0.04f));
                    rg = clamp01(g[i] / Math.max(bg[1][i], 0.04f));
                    rb = clamp01(b[i] / Math.max(bg[2][i], 0.04f));
                } else {
                    rr = clamp01((r[i] - bg[0][i]) / Math.max(1f - bg[0][i], 0.04f));
                    rg = clamp01((g[i] - bg[1][i]) / Math.max(1f - bg[1][i], 0.04f));
                    rb = clamp01((b[i] - bg[2][i]) / Math.max(1f - bg[2][i], 0.04f));
                }
                float maxc = Math.max(rr, Math.max(rg, rb));
                float minc = Math.min(rr, Math.min(rg, rb));
                float ink;
                if (opt.mode() == ProcessingOptions.Mode.BLACK) {
                    // Trait noir : seuls les pixels sombres dans les trois canaux
                    // (sur fond sombre, les traits clairs deviennent noirs).
                    float chroma = maxc - minc;
                    float neutral = (1f - chroma) * (1f - chroma);
                    ink = (dark ? minc : 1f - maxc) * neutral;
                } else {
                    ink = dark ? maxc : 1f - minc;
                }
                float a = smoothstep(t0, t0 + soft, ink);
                alpha[i] = a;
                if (opt.mode() == ProcessingOptions.Mode.BLACK) {
                    outR[i] = 0.04f;
                    outG[i] = 0.04f;
                    outB[i] = 0.05f;
                } else if (a > 0f) {
                    // Démélange : observé = a * encre + (1 - a) * fond
                    float k = Math.max(a, 0.08f);
                    if (!dark) {
                        outR[i] = clamp01((rr - (1f - a)) / k);
                        outG[i] = clamp01((rg - (1f - a)) / k);
                        outB[i] = clamp01((rb - (1f - a)) / k);
                    } else {
                        outR[i] = clamp01(rr / k);
                        outG[i] = clamp01(rg / k);
                        outB[i] = clamp01(rb / k);
                    }
                }
            }
        }

        int kept = removeSpecks(alpha, w, h, opt.cleanup());

        // Recadrage autour du motif
        int minX = w;
        int minY = h;
        int maxX = -1;
        int maxY = -1;
        for (int y = 0; y < h; y++) {
            for (int x = 0; x < w; x++) {
                if (alpha[y * w + x] > 0.03f) {
                    minX = Math.min(minX, x);
                    minY = Math.min(minY, y);
                    maxX = Math.max(maxX, x);
                    maxY = Math.max(maxY, y);
                }
            }
        }
        if (maxX < 0) {
            throw new IllegalArgumentException("Aucun motif détecté : essayez d'augmenter la tolérance.");
        }
        int margin = 4;
        minX = Math.max(0, minX - margin);
        minY = Math.max(0, minY - margin);
        maxX = Math.min(w - 1, maxX + margin);
        maxY = Math.min(h - 1, maxY + margin);
        int cw = maxX - minX + 1;
        int ch = maxY - minY + 1;
        BufferedImage out = new BufferedImage(cw, ch, BufferedImage.TYPE_INT_ARGB);
        int[] px = new int[cw * ch];
        for (int y = 0; y < ch; y++) {
            for (int x = 0; x < cw; x++) {
                int i = (y + minY) * w + (x + minX);
                int a = Math.round(clamp01(alpha[i]) * 255f);
                int pr = Math.round(clamp01(outR[i]) * 255f);
                int pg = Math.round(clamp01(outG[i]) * 255f);
                int pb = Math.round(clamp01(outB[i]) * 255f);
                px[y * cw + x] = (a << 24) | (pr << 16) | (pg << 8) | pb;
            }
        }
        out.setRGB(0, 0, cw, ch, px, 0, cw);
        return new Result(out, dark, hadTransparency, kept);
    }

    // ------------------------------------------------------------ fond

    /**
     * Fond estimé par une surface polynomiale (degré 3) ajustée sur les pixels
     * qui ressemblent au papier. Un éclairage inégal est une variation lente :
     * la surface le suit, sans jamais être trompée par de grands aplats de
     * couleur. Si trop peu de pixels ressemblent au fond, on se rabat sur une
     * enveloppe morphologique.
     */
    private float[][] estimateBackground(float[][] ch, int w, int h, boolean dark) {
        int step = Math.max(1, Math.round(Math.max(w, h) / 160f));
        int sw = (w + step - 1) / step;
        int sh = (h + step - 1) / step;
        int m = sw * sh;
        float[][] small = new float[3][m];
        for (int sy = 0; sy < sh; sy++) {
            for (int sx = 0; sx < sw; sx++) {
                int i = Math.min(h - 1, sy * step + step / 2) * w + Math.min(w - 1, sx * step + step / 2);
                for (int c = 0; c < 3; c++) {
                    small[c][sy * sw + sx] = ch[c][i];
                }
            }
        }
        // Couleur de départ : médiane des bords
        float[] ref = new float[3];
        for (int c = 0; c < 3; c++) {
            ref[c] = borderMedian(small[c], sw, sh);
        }
        boolean[] use = new boolean[m];
        int count = 0;
        for (int i = 0; i < m; i++) {
            float d = Math.abs(small[0][i] - ref[0]) + Math.abs(small[1][i] - ref[1]) + Math.abs(small[2][i] - ref[2]);
            use[i] = d < 0.30f;
            if (use[i]) {
                count++;
            }
        }
        if (count < m * 0.15f) {
            return envelopeBackground(ch, w, h, dark);
        }
        double[][] coef = new double[3][];
        for (int iter = 0; iter < 4; iter++) {
            for (int c = 0; c < 3; c++) {
                coef[c] = fitCubic(small[c], use, sw, sh);
            }
            // On ne garde que les pixels proches de la surface (rejet des traits)
            float[] res = new float[m];
            float sum = 0;
            int k = 0;
            for (int sy = 0; sy < sh; sy++) {
                for (int sx = 0; sx < sw; sx++) {
                    int i = sy * sw + sx;
                    double u = 2.0 * sx / Math.max(1, sw - 1) - 1;
                    double v = 2.0 * sy / Math.max(1, sh - 1) - 1;
                    float d = 0;
                    for (int c = 0; c < 3; c++) {
                        d += (float) Math.abs(small[c][i] - evalCubic(coef[c], u, v));
                    }
                    res[i] = d;
                    if (use[i]) {
                        sum += d;
                        k++;
                    }
                }
            }
            float limit = Math.max(0.05f, 2.5f * sum / Math.max(1, k));
            for (int i = 0; i < m; i++) {
                use[i] = res[i] < limit;
            }
        }
        float[][] result = new float[3][w * h];
        for (int y = 0; y < h; y++) {
            double v = 2.0 * ((y + 0.5) / step - 0.5) / Math.max(1, sh - 1) - 1;
            for (int x = 0; x < w; x++) {
                double u = 2.0 * ((x + 0.5) / step - 0.5) / Math.max(1, sw - 1) - 1;
                for (int c = 0; c < 3; c++) {
                    result[c][y * w + x] = clamp01((float) evalCubic(coef[c], u, v));
                }
            }
        }
        return result;
    }

    private static double[] cubicTerms(double u, double v) {
        return new double[] {1, u, v, u * u, u * v, v * v, u * u * u, u * u * v, u * v * v, v * v * v};
    }

    private static double evalCubic(double[] c, double u, double v) {
        double[] t = cubicTerms(u, v);
        double s = 0;
        for (int i = 0; i < t.length; i++) {
            s += c[i] * t[i];
        }
        return s;
    }

    /** Moindres carrés (équations normales + petite régularisation). */
    private static double[] fitCubic(float[] val, boolean[] use, int sw, int sh) {
        int k = 10;
        double[][] a = new double[k][k + 1];
        for (int sy = 0; sy < sh; sy++) {
            for (int sx = 0; sx < sw; sx++) {
                int i = sy * sw + sx;
                if (!use[i]) {
                    continue;
                }
                double[] t = cubicTerms(2.0 * sx / Math.max(1, sw - 1) - 1, 2.0 * sy / Math.max(1, sh - 1) - 1);
                for (int r = 0; r < k; r++) {
                    for (int c = 0; c < k; c++) {
                        a[r][c] += t[r] * t[c];
                    }
                    a[r][k] += t[r] * val[i];
                }
            }
        }
        for (int r = 0; r < k; r++) {
            a[r][r] += 1e-3;
        }
        // Élimination de Gauss avec pivot partiel
        for (int col = 0; col < k; col++) {
            int piv = col;
            for (int r = col + 1; r < k; r++) {
                if (Math.abs(a[r][col]) > Math.abs(a[piv][col])) {
                    piv = r;
                }
            }
            double[] tmp = a[col];
            a[col] = a[piv];
            a[piv] = tmp;
            for (int r = 0; r < k; r++) {
                if (r == col) {
                    continue;
                }
                double f = a[r][col] / a[col][col];
                for (int c = col; c <= k; c++) {
                    a[r][c] -= f * a[col][c];
                }
            }
        }
        double[] out = new double[k];
        for (int r = 0; r < k; r++) {
            out[r] = a[r][k] / a[r][r];
        }
        return out;
    }

    private static float borderMedian(float[] v, int w, int h) {
        int[] hist = new int[256];
        int count = 0;
        for (int x = 0; x < w; x++) {
            hist[Math.round(clamp01(v[x]) * 255f)]++;
            hist[Math.round(clamp01(v[(h - 1) * w + x]) * 255f)]++;
            count += 2;
        }
        for (int y = 0; y < h; y++) {
            hist[Math.round(clamp01(v[y * w]) * 255f)]++;
            hist[Math.round(clamp01(v[y * w + w - 1]) * 255f)]++;
            count += 2;
        }
        int acc = 0;
        for (int i = 0; i < 256; i++) {
            acc += hist[i];
            if (acc >= count / 2) {
                return i / 255f;
            }
        }
        return 1f;
    }

    /**
     * Repli : enveloppe morphologique sur une image réduite (fermeture pour un
     * fond clair, ouverture pour un fond sombre), puis flou.
     */
    private float[][] envelopeBackground(float[][] ch, int w, int h, boolean dark) {
        int step = Math.max(1, Math.round(Math.max(w, h) / 256f));
        int sw = (w + step - 1) / step;
        int sh = (h + step - 1) / step;
        int radius = 7;
        float[][] result = new float[3][];
        for (int c = 0; c < 3; c++) {
            float[] small = new float[sw * sh];
            for (int sy = 0; sy < sh; sy++) {
                for (int sx = 0; sx < sw; sx++) {
                    float v = dark ? 1f : 0f;
                    for (int y = sy * step; y < Math.min(h, (sy + 1) * step); y++) {
                        for (int x = sx * step; x < Math.min(w, (sx + 1) * step); x++) {
                            float p = ch[c][y * w + x];
                            v = dark ? Math.min(v, p) : Math.max(v, p);
                        }
                    }
                    small[sy * sw + sx] = v;
                }
            }
            float[] env;
            if (!dark) {
                env = minFilter(maxFilter(small, sw, sh, radius), sw, sh, radius / 2);
            } else {
                env = maxFilter(minFilter(small, sw, sh, radius), sw, sh, radius / 2);
            }
            env = boxBlur(boxBlur(env, sw, sh, 3), sw, sh, 3);
            result[c] = upsample(env, sw, sh, w, h, step);
        }
        return result;
    }

    private static float[] maxFilter(float[] src, int w, int h, int r) {
        return extremeFilter(src, w, h, r, true);
    }

    private static float[] minFilter(float[] src, int w, int h, int r) {
        return extremeFilter(src, w, h, r, false);
    }

    /** Filtre min/max séparable (horizontal puis vertical). */
    private static float[] extremeFilter(float[] src, int w, int h, int r, boolean max) {
        float[] tmp = new float[w * h];
        float[] dst = new float[w * h];
        for (int y = 0; y < h; y++) {
            for (int x = 0; x < w; x++) {
                float v = src[y * w + x];
                for (int k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) {
                    float p = src[y * w + k];
                    v = max ? Math.max(v, p) : Math.min(v, p);
                }
                tmp[y * w + x] = v;
            }
        }
        for (int y = 0; y < h; y++) {
            for (int x = 0; x < w; x++) {
                float v = tmp[y * w + x];
                for (int k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) {
                    float p = tmp[k * w + x];
                    v = max ? Math.max(v, p) : Math.min(v, p);
                }
                dst[y * w + x] = v;
            }
        }
        return dst;
    }

    private static float[] boxBlur(float[] src, int w, int h, int r) {
        float[] tmp = new float[w * h];
        float[] dst = new float[w * h];
        for (int y = 0; y < h; y++) {
            for (int x = 0; x < w; x++) {
                float s = 0;
                int c = 0;
                for (int k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) {
                    s += src[y * w + k];
                    c++;
                }
                tmp[y * w + x] = s / c;
            }
        }
        for (int y = 0; y < h; y++) {
            for (int x = 0; x < w; x++) {
                float s = 0;
                int c = 0;
                for (int k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) {
                    s += tmp[k * w + x];
                    c++;
                }
                dst[y * w + x] = s / c;
            }
        }
        return dst;
    }

    /** Agrandissement bilinéaire de l'image réduite vers la taille d'origine. */
    private static float[] upsample(float[] small, int sw, int sh, int w, int h, int step) {
        float[] out = new float[w * h];
        for (int y = 0; y < h; y++) {
            float fy = Math.min(sh - 1f, Math.max(0f, (y + 0.5f) / step - 0.5f));
            int y0 = (int) fy;
            int y1 = Math.min(sh - 1, y0 + 1);
            float ty = fy - y0;
            for (int x = 0; x < w; x++) {
                float fx = Math.min(sw - 1f, Math.max(0f, (x + 0.5f) / step - 0.5f));
                int x0 = (int) fx;
                int x1 = Math.min(sw - 1, x0 + 1);
                float tx = fx - x0;
                float a = small[y0 * sw + x0] * (1 - tx) + small[y0 * sw + x1] * tx;
                float c = small[y1 * sw + x0] * (1 - tx) + small[y1 * sw + x1] * tx;
                out[y * w + x] = a * (1 - ty) + c * ty;
            }
        }
        return out;
    }

    /** Luminance médiane des bords : sert à détecter un fond sombre. */
    private static float borderLuminance(float[] r, float[] g, float[] b, int w, int h) {
        int[] hist = new int[256];
        int count = 0;
        for (int x = 0; x < w; x++) {
            for (int y : new int[] {0, h - 1}) {
                int i = y * w + x;
                hist[Math.round(lum(r[i], g[i], b[i]) * 255f)]++;
                count++;
            }
        }
        for (int y = 0; y < h; y++) {
            for (int x : new int[] {0, w - 1}) {
                int i = y * w + x;
                hist[Math.round(lum(r[i], g[i], b[i]) * 255f)]++;
                count++;
            }
        }
        int acc = 0;
        for (int v = 0; v < 256; v++) {
            acc += hist[v];
            if (acc >= count / 2) {
                return v / 255f;
            }
        }
        return 1f;
    }

    // ------------------------------------------------------------ nettoyage

    /**
     * Supprime les composantes connexes plus petites qu'un seuil, puis efface
     * les pixels semi-transparents qui ne touchent aucun élément conservé.
     *
     * @return nombre de pixels conservés
     */
    private static int removeSpecks(float[] alpha, int w, int h, float cleanup) {
        int n = w * h;
        int minArea = Math.round(cleanup * cleanup * 0.0006f * n) + 1;
        int[] label = new int[n];
        boolean[] keep = new boolean[n];
        ArrayDeque<Integer> queue = new ArrayDeque<>();
        int[] pixels = new int[n];
        int kept = 0;
        int current = 0;
        for (int start = 0; start < n; start++) {
            if (label[start] != 0 || alpha[start] <= 0.5f) {
                continue;
            }
            current++;
            int size = 0;
            queue.add(start);
            label[start] = current;
            while (!queue.isEmpty()) {
                int i = queue.poll();
                pixels[size++] = i;
                int x = i % w;
                int y = i / w;
                int[] nb = {x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1};
                for (int j : nb) {
                    if (j >= 0 && label[j] == 0 && alpha[j] > 0.5f) {
                        label[j] = current;
                        queue.add(j);
                    }
                }
            }
            if (size >= minArea) {
                for (int k = 0; k < size; k++) {
                    keep[pixels[k]] = true;
                }
                kept += size;
            }
        }
        // Zone autorisée : éléments conservés + 2 pixels autour (bords doux)
        boolean[] near = new boolean[n];
        for (int y = 0; y < h; y++) {
            for (int x = 0; x < w; x++) {
                if (!keep[y * w + x]) {
                    continue;
                }
                for (int dy = -2; dy <= 2; dy++) {
                    for (int dx = -2; dx <= 2; dx++) {
                        int xx = x + dx;
                        int yy = y + dy;
                        if (xx >= 0 && yy >= 0 && xx < w && yy < h) {
                            near[yy * w + xx] = true;
                        }
                    }
                }
            }
        }
        for (int i = 0; i < n; i++) {
            if (!near[i]) {
                alpha[i] = 0f;
            }
        }
        return kept;
    }

    // ------------------------------------------------------------ utilitaires

    private static BufferedImage limitSize(BufferedImage img) {
        int w = img.getWidth();
        int h = img.getHeight();
        int max = Math.max(w, h);
        if (max <= MAX_SIDE && img.getType() == BufferedImage.TYPE_INT_ARGB) {
            return img;
        }
        double s = Math.min(1.0, (double) MAX_SIDE / max);
        int nw = Math.max(1, (int) Math.round(w * s));
        int nh = Math.max(1, (int) Math.round(h * s));
        BufferedImage out = new BufferedImage(nw, nh, BufferedImage.TYPE_INT_ARGB);
        java.awt.Graphics2D g = out.createGraphics();
        g.setRenderingHint(java.awt.RenderingHints.KEY_INTERPOLATION, java.awt.RenderingHints.VALUE_INTERPOLATION_BILINEAR);
        g.setRenderingHint(java.awt.RenderingHints.KEY_RENDERING, java.awt.RenderingHints.VALUE_RENDER_QUALITY);
        g.drawImage(img, 0, 0, nw, nh, null);
        g.dispose();
        return out;
    }

    private static float lum(float r, float g, float b) {
        return 0.299f * r + 0.587f * g + 0.114f * b;
    }

    private static float clamp01(float v) {
        return v < 0f ? 0f : (v > 1f ? 1f : v);
    }

    private static float smoothstep(float e0, float e1, float x) {
        float t = clamp01((x - e0) / (e1 - e0));
        return t * t * (3f - 2f * t);
    }
}

// GROGNON
