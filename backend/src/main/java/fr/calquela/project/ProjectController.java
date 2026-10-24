package fr.calquela.project;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import fr.calquela.config.CalqueLaProperties;
import fr.calquela.web.ApiException;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Partage de projets par lien.
 * <ul>
 *   <li>POST /api/projects : enregistre un projet (JSON) et renvoie son identifiant ;</li>
 *   <li>GET /api/projects/{id} : renvoie le projet.</li>
 * </ul>
 */
@RestController
@RequestMapping("/api/projects")
public class ProjectController {

    private final ProjectStore store;
    private final ObjectMapper mapper;
    private final long maxBytes;

    public ProjectController(ProjectStore store, ObjectMapper mapper, CalqueLaProperties properties) {
        this.store = store;
        this.mapper = mapper;
        this.maxBytes = properties.maxProjectBytes();
    }

    @PostMapping(consumes = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<Map<String, String>> share(@RequestBody String body) throws IOException {
        if (body.getBytes(StandardCharsets.UTF_8).length > maxBytes) {
            throw new ApiException(HttpStatus.PAYLOAD_TOO_LARGE, "Projet trop volumineux pour être partagé.");
        }
        JsonNode root;
        try {
            root = mapper.readTree(body);
        } catch (JsonProcessingException e) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "Projet illisible.");
        }
        if (root == null || !root.isObject() || !"CalqueLa".equals(root.path("app").asText())) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "Ce fichier n'est pas un projet CalqueLa.");
        }
        // On réécrit le JSON analysé (et non le texte reçu) : contenu normalisé
        String id = store.save(mapper.writeValueAsString(root));
        return ResponseEntity.status(HttpStatus.CREATED).body(Map.of("id", id));
    }

    @GetMapping("/{id}")
    public ResponseEntity<byte[]> load(@PathVariable String id) throws IOException {
        Path file = store.find(id)
                .orElseThrow(() -> new ApiException(HttpStatus.NOT_FOUND, "Projet introuvable ou expiré."));
        return ResponseEntity.ok()
                .contentType(MediaType.APPLICATION_JSON)
                .cacheControl(CacheControl.maxAge(1, TimeUnit.HOURS).cachePrivate())
                .body(Files.readAllBytes(file));
    }
}

// GROGNON
