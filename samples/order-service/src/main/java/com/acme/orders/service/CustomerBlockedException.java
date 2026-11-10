package com.acme.orders.service;

public class CustomerBlockedException extends RuntimeException {
    public CustomerBlockedException(Long customerId) {
        super("Customer " + customerId + " is blocked");
    }
}
