package com.acme.orders.messaging;

public record OrderCreatedEvent(Long orderId, String customerEmail) {}
