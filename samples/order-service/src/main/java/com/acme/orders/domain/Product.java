package com.acme.orders.domain;

import jakarta.persistence.*;
import java.math.BigDecimal;
import lombok.Getter;

@Entity
@Table(name = "products")
@Getter
public class Product {
    @Id
    private String sku;
    private String name;
    @Column(precision = 12, scale = 2)
    private BigDecimal price;
}
