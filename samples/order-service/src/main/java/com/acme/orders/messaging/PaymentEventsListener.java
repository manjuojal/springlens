package com.acme.orders.messaging;

import com.acme.orders.service.OrderService;
import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.stereotype.Component;

@Component
public class PaymentEventsListener {

    private final OrderService orderService;

    public PaymentEventsListener(OrderService orderService) {
        this.orderService = orderService;
    }

    @KafkaListener(topics = "${app.kafka.payment-topic}", groupId = "order-service")
    public void onPaymentEvent(PaymentEvent event) {
        if ("CAPTURED".equals(event.status())) {
            orderService.markPaid(event.orderId(), event.reference());
        }
    }

    public record PaymentEvent(Long orderId, String status, String reference) {}
}
