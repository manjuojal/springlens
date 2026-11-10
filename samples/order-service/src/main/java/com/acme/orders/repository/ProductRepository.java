package com.acme.orders.repository;

import com.acme.orders.domain.Product;
import java.util.Optional;
import org.springframework.data.jpa.repository.JpaRepository;

public interface ProductRepository extends JpaRepository<Product, String> {
    Optional<Product> findBySku(String sku);
}
