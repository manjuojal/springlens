package com.acme.orders.jobs;

import com.acme.orders.repository.OrderRepository;
import java.time.Duration;
import java.time.Instant;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

@Component
public class StaleOrderCleanupJob {

    private final OrderRepository orderRepository;

    public StaleOrderCleanupJob(OrderRepository orderRepository) {
        this.orderRepository = orderRepository;
    }

    @Scheduled(cron = "${app.cleanup.cron}")
    @Transactional
    public void purgeStaleOrders() {
        orderRepository.deleteStaleOrders(Instant.now().minus(Duration.ofDays(2)));
    }
}
