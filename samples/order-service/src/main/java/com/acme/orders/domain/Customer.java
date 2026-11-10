package com.acme.orders.domain;

import jakarta.persistence.*;
import jakarta.validation.constraints.Email;
import java.util.List;
import lombok.Getter;

@Entity
@Table(name = "customers")
@Getter
public class Customer {
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Email
    @Column(nullable = false, unique = true)
    private String email;

    private String name;

    private boolean blocked;

    @OneToMany(mappedBy = "customer")
    private List<Order> orders;
}
