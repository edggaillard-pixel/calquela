package fr.calquela;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.ConfigurationPropertiesScan;
import org.springframework.scheduling.annotation.EnableScheduling;

/**
 * Point d'entrée de CalqueLa.
 * Sert le site (dossier static), traite les images de tatouage et stocke les
 * projets partagés sous forme de fichiers (aucune base de données).
 */
@SpringBootApplication
@EnableScheduling
@ConfigurationPropertiesScan
public class CalqueLaApplication {

    public static void main(String[] args) {
        SpringApplication.run(CalqueLaApplication.class, args);
    }
}

// GROGNON
