package fr.calquela.tattoo;

import fr.calquela.web.ApiException;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.Iterator;
import java.util.Locale;
import javax.imageio.ImageIO;
import javax.imageio.ImageReader;
import javax.imageio.stream.ImageInputStream;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RequestPart;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;

/**
 * POST /api/tattoos/process : reçoit une image et renvoie le motif détouré (PNG).
 */
@RestController
@RequestMapping("/api/tattoos")
public class TattooController {

    /** Au-delà, l'image est refusée avant même d'être décodée (protection mémoire). */
    private static final long MAX_PIXELS = 40_000_000L;

    private final TattooProcessor processor = new TattooProcessor();

    @PostMapping(value = "/process", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public ResponseEntity<byte[]> process(
            @RequestPart("image") MultipartFile file,
            @RequestParam(defaultValue = "color") String mode,
            @RequestParam(defaultValue = "0.35") float tolerance,
            @RequestParam(defaultValue = "0.3") float softness,
            @RequestParam(defaultValue = "0.3") float cleanup) throws IOException {

        if (file.isEmpty()) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "Aucune image reçue.");
        }
        BufferedImage image = readImage(file);
        ProcessingOptions.Mode m = "black".equals(mode.toLowerCase(Locale.ROOT))
                ? ProcessingOptions.Mode.BLACK : ProcessingOptions.Mode.COLOR;
        TattooProcessor.Result result;
        try {
            result = processor.process(image, new ProcessingOptions(m, tolerance, softness, cleanup));
        } catch (IllegalArgumentException e) {
            throw new ApiException(HttpStatus.UNPROCESSABLE_ENTITY, e.getMessage());
        }
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        ImageIO.write(result.image(), "png", out);
        return ResponseEntity.ok()
                .contentType(MediaType.IMAGE_PNG)
                .cacheControl(CacheControl.noStore())
                .header("X-Fond-Sombre", Boolean.toString(result.darkBackground()))
                .header("X-Deja-Detoure", Boolean.toString(result.hadTransparency()))
                .body(out.toByteArray());
    }

    /**
     * Décode l'image en vérifiant d'abord ses dimensions : un fichier de
     * quelques Mo peut annoncer une image gigantesque (« bombe de décompression »).
     */
    private static BufferedImage readImage(MultipartFile file) throws IOException {
        try (InputStream in = file.getInputStream(); ImageInputStream iis = ImageIO.createImageInputStream(in)) {
            if (iis == null) {
                throw new ApiException(HttpStatus.BAD_REQUEST, "Fichier illisible.");
            }
            Iterator<ImageReader> readers = ImageIO.getImageReaders(iis);
            if (!readers.hasNext()) {
                throw new ApiException(HttpStatus.UNSUPPORTED_MEDIA_TYPE, "Format non pris en charge (PNG ou JPEG attendu).");
            }
            ImageReader reader = readers.next();
            try {
                reader.setInput(iis, true, true);
                long pixels = (long) reader.getWidth(0) * reader.getHeight(0);
                if (pixels > MAX_PIXELS) {
                    throw new ApiException(HttpStatus.PAYLOAD_TOO_LARGE, "Image trop grande.");
                }
                return reader.read(0);
            } finally {
                reader.dispose();
            }
        }
    }
}

// GROGNON
