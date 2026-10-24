package fr.calquela.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * Réglages propres à CalqueLa (préfixe « calquela » dans application.properties).
 *
 * @param storageDir         dossier où sont écrits les projets partagés
 * @param retentionDays      durée de conservation d'un projet partagé
 * @param maxProjectBytes    taille maximale d'un projet partagé
 * @param requestsPerMinute  nombre de requêtes d'écriture autorisées par minute et par adresse IP
 */
@ConfigurationProperties(prefix = "calquela")
public record CalqueLaProperties(String storageDir, int retentionDays, long maxProjectBytes, int requestsPerMinute) {

    public CalqueLaProperties {
        if (storageDir == null || storageDir.isBlank()) {
            storageDir = "./data/projects";
        }
        if (retentionDays <= 0) {
            retentionDays = 30;
        }
        if (maxProjectBytes <= 0) {
            maxProjectBytes = 15L * 1024 * 1024;
        }
        if (requestsPerMinute <= 0) {
            requestsPerMinute = 30;
        }
    }
}

// GROGNON
