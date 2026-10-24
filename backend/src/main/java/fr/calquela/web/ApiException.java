package fr.calquela.web;

import org.springframework.http.HttpStatus;

/** Erreur prévue, renvoyée au navigateur avec un message en français. */
public class ApiException extends RuntimeException {

    private final HttpStatus status;

    public ApiException(HttpStatus status, String message) {
        super(message);
        this.status = status;
    }

    public HttpStatus getStatus() {
        return status;
    }
}

// GROGNON
