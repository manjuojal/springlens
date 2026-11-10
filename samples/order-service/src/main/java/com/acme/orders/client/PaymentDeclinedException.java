package com.acme.orders.client;

public class PaymentDeclinedException extends RuntimeException {
    public PaymentDeclinedException(String message) {
        super(message);
    }

    public PaymentDeclinedException(String message, Throwable cause) {
        super(message, cause);
    }
}
