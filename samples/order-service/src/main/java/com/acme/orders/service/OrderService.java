package com.acme.orders.service;

import com.acme.orders.domain.Order;
import com.acme.orders.domain.OrderStatus;
import com.acme.orders.web.OrderController.CreateOrderRequest;
import java.util.List;

public interface OrderService {
    List<Order> findForCurrentCustomer(OrderStatus status);
    Order getOrder(Long id);
    Order placeOrder(CreateOrderRequest request);
    void cancel(Long id);
    void delete(Long id);
    void markPaid(Long orderId, String paymentRef);
}
