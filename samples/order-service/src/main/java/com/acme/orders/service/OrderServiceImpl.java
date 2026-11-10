package com.acme.orders.service;

import com.acme.orders.client.InventoryClient;
import com.acme.orders.client.PaymentGateway;
import com.acme.orders.domain.Customer;
import com.acme.orders.domain.Order;
import com.acme.orders.domain.OrderItem;
import com.acme.orders.domain.OrderStatus;
import com.acme.orders.messaging.OrderCreatedEvent;
import com.acme.orders.repository.CustomerRepository;
import com.acme.orders.repository.OrderRepository;
import com.acme.orders.security.TenantFilter.TenantContext;
import com.acme.orders.web.OrderController.CreateOrderRequest;
import java.util.List;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.cache.annotation.CacheEvict;
import org.springframework.cache.annotation.Cacheable;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Slf4j
@Service
@RequiredArgsConstructor
public class OrderServiceImpl implements OrderService {

    private final OrderRepository orderRepository;
    private final CustomerRepository customerRepository;
    private final InventoryClient inventoryClient;
    private final PaymentGateway paymentGateway;
    private final PricingService pricingService;
    private final KafkaTemplate<String, Object> kafkaTemplate;
    private final ApplicationEventPublisher events;

    @Value("${app.kafka.order-topic}")
    private String orderTopic;

    @Override
    @Transactional(readOnly = true)
    public List<Order> findForCurrentCustomer(OrderStatus status) {
        String tenant = TenantContext.get();
        return status == null ? orderRepository.findByTenant(tenant) : orderRepository.findByTenantAndStatus(tenant, status);
    }

    @Override
    @Cacheable(value = "orders", key = "#id")
    public Order getOrder(Long id) {
        return orderRepository.findById(id).orElseThrow(() -> new OrderNotFoundException(id));
    }

    @Override
    @Transactional
    public Order placeOrder(CreateOrderRequest request) {
        log.info("Placing order for customer {} with {} items", request.customerId(), request.items().size());
        if (request.items() == null || request.items().isEmpty()) {
            log.warn("Rejecting empty order for customer {}", request.customerId());
            throw new IllegalArgumentException("Order must contain at least one item");
        }
        Customer customer = customerRepository.findById(request.customerId())
                .orElseThrow(() -> new IllegalArgumentException("Unknown customer " + request.customerId()));
        if (customer.isBlocked()) {
            log.warn("Customer {} is blocked, order refused", customer.getId());
            throw new CustomerBlockedException(customer.getId());
        }
        for (var line : request.items()) {
            log.debug("Reserving {} x {}", line.quantity(), line.sku());
            inventoryClient.reserve(line.sku(), line.quantity());
        }
        Order order = new Order(customer, TenantContext.get());
        request.items().forEach(l -> order.addItem(new OrderItem(l.sku(), l.quantity())));
        order.setTotal(pricingService.priceOrder(order));
        Order saved = orderRepository.save(order);
        log.info("Order {} saved with total {}", saved.getId(), saved.getTotal());
        String paymentRef = paymentGateway.authorize(saved.getId(), saved.getTotal());
        saved.setPaymentRef(paymentRef);
        kafkaTemplate.send(orderTopic, saved.getId().toString(), saved);
        log.info("Order {} published to {}", saved.getId(), orderTopic);
        events.publishEvent(new OrderCreatedEvent(saved.getId(), customer.getEmail()));
        return saved;
    }

    @Override
    @Transactional
    @CacheEvict(value = "orders", key = "#id")
    public void cancel(Long id) {
        Order order = getOrder(id);
        if (order.getStatus() == OrderStatus.SHIPPED) {
            log.warn("Order {} already shipped, cannot cancel", id);
            throw new IllegalStateException("Order " + id + " already shipped");
        }
        order.setStatus(OrderStatus.CANCELLED);
        paymentGateway.voidAuthorization(order.getPaymentRef());
        orderRepository.save(order);
        kafkaTemplate.send(orderTopic, id.toString(), order);
        log.info("Order {} cancelled", id);
    }

    @Override
    @Transactional
    public void delete(Long id) {
        orderRepository.deleteById(id);
    }

    @Override
    @Transactional
    public void markPaid(Long orderId, String paymentRef) {
        orderRepository.updateStatus(orderId, OrderStatus.PAID);
    }
}
