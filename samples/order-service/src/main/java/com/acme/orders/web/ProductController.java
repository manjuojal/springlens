package com.acme.orders.web;

import com.acme.orders.client.InventoryClient;
import com.acme.orders.repository.ProductRepository;
import java.util.List;
import org.springframework.cache.annotation.Cacheable;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class ProductController implements ProductsApi {

    private final ProductRepository products;
    private final InventoryClient inventory;

    public ProductController(ProductRepository products, InventoryClient inventory) {
        this.products = products;
        this.inventory = inventory;
    }

    @Override
    @Cacheable("products")
    public ResponseEntity<List<ProductDto>> listProducts() {
        return ResponseEntity.ok(products.findAll().stream().map(p -> new ProductDto(p.getSku(), p.getName(), 0)).toList());
    }

    @Override
    public ResponseEntity<ProductDto> getProduct(String sku) {
        var product = products.findBySku(sku).orElseThrow();
        int stock = inventory.getStock(sku).available();
        return ResponseEntity.ok(new ProductDto(product.getSku(), product.getName(), stock));
    }

    public record ProductDto(String sku, String name, int stock) {}
}
