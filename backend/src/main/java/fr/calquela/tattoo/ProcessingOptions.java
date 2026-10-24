package fr.calquela.tattoo;

/**
 * Réglages du traitement d'image, tous normalisés entre 0 et 1.
 *
 * @param mode      COLOR garde toutes les couleurs, BLACK ne garde que le trait noir
 * @param tolerance plus la valeur est haute, plus on retire de fond (et de détails clairs)
 * @param softness  douceur des bords
 * @param cleanup   taille des petites taches à supprimer
 */
public record ProcessingOptions(Mode mode, float tolerance, float softness, float cleanup) {

    public enum Mode { COLOR, BLACK }

    public ProcessingOptions {
        if (mode == null) {
            mode = Mode.COLOR;
        }
        tolerance = clamp(tolerance);
        softness = clamp(softness);
        cleanup = clamp(cleanup);
    }

    public static ProcessingOptions defaults() {
        return new ProcessingOptions(Mode.COLOR, 0.35f, 0.3f, 0.3f);
    }

    private static float clamp(float v) {
        if (Float.isNaN(v)) {
            return 0.5f;
        }
        return Math.max(0f, Math.min(1f, v));
    }
}

// GROGNON
