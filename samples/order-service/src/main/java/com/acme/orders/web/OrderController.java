package com.acme.orders.web;

import com.acme.orders.domain.Order;
import com.acme.orders.domain.OrderStatus;
import com.acme.orders.service.OrderService;
import jakarta.validation.Valid;
import java.util.List;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/v1/orders")
@RequiredArgsConstructor
public class OrderController {

    private final OrderService orderService;

    @GetMapping
    public List<OrderDto> list(@RequestParam(required = false) OrderStatus status) {
        return orderService.findForCurrentCustomer(status).stream().map(OrderDto::from).toList();
    }

    @GetMapping("/{id}")
    public ResponseEntity<OrderDto> get(@PathVariable Long id) {
        return ResponseEntity.ok(OrderDto.from(orderService.getOrder(id)));
    }

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    public OrderDto create(@Valid @RequestBody CreateOrderRequest request) {
        Order order = orderService.placeOrder(request);
        return OrderDto.from(order);
    }

    @PostMapping("/{id}/cancel")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void cancel(@PathVariable Long id) {
        orderService.cancel(id);
    }

    @DeleteMapping("/{id}")
    @PreAuthorize("hasRole('ADMIN')")
    public void delete(@PathVariable("id") Long id) {
        orderService.delete(id);
    }

    public record CreateOrderRequest(Long customerId, List<Line> items) {
        public record Line(String sku, int quantity) {}
    }

    public record OrderDto(Long id, String status, java.math.BigDecimal total) {
        static OrderDto from(Order o) { return new OrderDto(o.getId(), o.getStatus().name(), o.getTotal()); }
    }
}
