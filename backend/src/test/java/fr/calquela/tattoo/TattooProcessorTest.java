package fr.calquela.tattoo;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.awt.BasicStroke;
import java.awt.Color;
import java.awt.Graphics2D;
import java.awt.image.BufferedImage;
import org.junit.jupiter.api.Test;

class TattooProcessorTest {

    private final TattooProcessor processor = new TattooProcessor();

    /** Papier crème avec un dégradé d'ombre, un cercle noir et un disque rouge. */
    private static BufferedImage sampleFlash() {
        int w = 400;
        int h = 300;
        BufferedImage img = new BufferedImage(w, h, BufferedImage.TYPE_INT_RGB);
        for (int y = 0; y < h; y++) {
            for (int x = 0; x < w; x++) {
                float shade = 1f - 0.25f * (x / (float) w) * (y / (float) h);
                int r = Math.round(238 * shade);
                int g = Math.round(230 * shade);
                int b = Math.round(210 * shade);
                img.setRGB(x, y, (r << 16) | (g << 8) | b);
            }
        }
        Graphics2D g = img.createGraphics();
        g.setColor(new Color(200, 30, 40));
        g.fillOval(150, 100, 100, 100);
        g.setColor(Color.BLACK);
        g.setStroke(new BasicStroke(6));
        g.drawOval(150, 100, 100, 100);
        g.dispose();
        return img;
    }

    private static int alphaAt(BufferedImage img, int x, int y) {
        return (img.getRGB(x, y) >>> 24) & 0xFF;
    }

    @Test
    void retireLeFondEtGardeLaCouleur() {
        var result = processor.process(sampleFlash(), ProcessingOptions.defaults());
        BufferedImage out = result.image();
        // recadré autour du motif (≈ 106 px + marges)
        assertTrue(out.getWidth() < 130 && out.getHeight() < 130, "recadrage attendu");
        // coin : transparent
        assertEquals(0, alphaAt(out, 0, 0));
        // centre : rouge opaque
        int c = out.getRGB(out.getWidth() / 2, out.getHeight() / 2);
        assertTrue(((c >>> 24) & 0xFF) > 240, "centre opaque");
        assertTrue(((c >> 16) & 0xFF) > 150 && ((c >> 8) & 0xFF) < 90, "centre rouge");
    }

    @Test
    void modeNoirIgnoreLesAplatsDeCouleur() {
        var opt = new ProcessingOptions(ProcessingOptions.Mode.BLACK, 0.35f, 0.3f, 0.3f);
        BufferedImage out = processor.process(sampleFlash(), opt).image();
        assertEquals(0, alphaAt(out, out.getWidth() / 2, out.getHeight() / 2), "le rouge doit disparaître");
    }

    @Test
    void imageVideDeclencheUneErreurClaire() {
        BufferedImage blank = new BufferedImage(50, 50, BufferedImage.TYPE_INT_RGB);
        Graphics2D g = blank.createGraphics();
        g.setColor(Color.WHITE);
        g.fillRect(0, 0, 50, 50);
        g.dispose();
        assertThrows(IllegalArgumentException.class, () -> processor.process(blank, ProcessingOptions.defaults()));
    }
}

// GROGNON
