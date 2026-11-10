package com.acme.orders.domain;

import jakarta.persistence.*;
import lombok.Getter;
import lombok.Setter;

@Entity
@Table(name = "order_items")
@Getter
@Setter
public class OrderItem {
    @Id
    @GeneratedValue
    private Long id;

    @Column(nullable = false, length = 64)
    private String sku;

    private int quantity;

    @ManyToOne
    @JoinColumn(name = "order_id")
    private Order order;

    protected OrderItem() {}

    public OrderItem(String sku, int quantity) {
        this.sku = sku;
        this.quantity = quantity;
    }
}
