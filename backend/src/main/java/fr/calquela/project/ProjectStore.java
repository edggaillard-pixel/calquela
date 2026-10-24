package fr.calquela.project;

import fr.calquela.config.CalqueLaProperties;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.SecureRandom;
import java.time.Duration;
import java.time.Instant;
import java.util.Optional;
import java.util.regex.Pattern;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

/**
 * Stockage des projets partagés dans des fichiers JSON (pas de base de données).
 * Chaque projet reçoit un identifiant aléatoire de 12 caractères, impossible à
 * deviner : seule la personne qui a le lien peut ouvrir le projet.
 */
@Service
public class ProjectStore {

    private static final Logger LOG = LoggerFactory.getLogger(ProjectStore.class);
    private static final String ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
    private static final Pattern ID = Pattern.compile("^[A-Za-z0-9]{12}$");

    private final Path dir;
    private final Duration retention;
    private final SecureRandom random = new SecureRandom();

    public ProjectStore(CalqueLaProperties properties) throws IOException {
        this.dir = Path.of(properties.storageDir()).toAbsolutePath().normalize();
        this.retention = Duration.ofDays(properties.retentionDays());
        Files.createDirectories(dir);
        LOG.info("Projets partagés stockés dans {}", dir);
    }

    public static boolean isValidId(String id) {
        return id != null && ID.matcher(id).matches();
    }

    /** Enregistre le projet et renvoie son identifiant. */
    public String save(String json) throws IOException {
        String id;
        Path target;
        do {
            id = newId();
            target = dir.resolve(id + ".json");
        } while (Files.exists(target));
        // Écriture atomique : fichier temporaire puis renommage
        Path tmp = Files.createTempFile(dir, "upload-", ".tmp");
        try {
            Files.writeString(tmp, json, StandardCharsets.UTF_8);
            Files.move(tmp, target, StandardCopyOption.ATOMIC_MOVE);
        } finally {
            Files.deleteIfExists(tmp);
        }
        return id;
    }

    public Optional<Path> find(String id) {
        if (!isValidId(id)) {
            return Optional.empty();
        }
        Path p = dir.resolve(id + ".json").normalize();
        // Double vérification : le chemin doit rester dans le dossier de stockage
        if (!p.startsWith(dir) || !Files.isRegularFile(p)) {
            return Optional.empty();
        }
        return Optional.of(p);
    }

    /** Supprime chaque nuit les projets plus anciens que la durée de conservation. */
    @Scheduled(cron = "0 15 3 * * *")
    public void purgeOldProjects() {
        Instant limit = Instant.now().minus(retention);
        int removed = 0;
        try (DirectoryStream<Path> files = Files.newDirectoryStream(dir, "*.json")) {
            for (Path f : files) {
                if (Files.getLastModifiedTime(f).toInstant().isBefore(limit)) {
                    Files.deleteIfExists(f);
                    removed++;
                }
            }
        } catch (IOException e) {
            LOG.warn("Nettoyage des projets impossible : {}", e.getMessage());
        }
        if (removed > 0) {
            LOG.info("{} projet(s) expiré(s) supprimé(s)", removed);
        }
    }

    private String newId() {
        StringBuilder sb = new StringBuilder(12);
        for (int i = 0; i < 12; i++) {
            sb.append(ALPHABET.charAt(random.nextInt(ALPHABET.length())));
        }
        return sb.toString();
    }
}

// GROGNON
