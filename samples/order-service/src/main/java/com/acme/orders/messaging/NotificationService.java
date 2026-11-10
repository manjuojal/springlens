package com.acme.orders.messaging;

import org.springframework.mail.SimpleMailMessage;
import org.springframework.mail.javamail.JavaMailSender;
import org.springframework.scheduling.annotation.Async;
import org.springframework.stereotype.Service;
import org.springframework.transaction.event.TransactionalEventListener;

@Service
public class NotificationService {

    private final JavaMailSender mailSender;

    public NotificationService(JavaMailSender mailSender) {
        this.mailSender = mailSender;
    }

    @Async
    @TransactionalEventListener
    public void onOrderCreated(OrderCreatedEvent event) {
        SimpleMailMessage msg = new SimpleMailMessage();
        msg.setTo(event.customerEmail());
        msg.setSubject("Order #" + event.orderId() + " received");
        mailSender.send(msg);
    }
}
