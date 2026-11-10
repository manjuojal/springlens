package com.acme.orders.client;

import org.springframework.cloud.openfeign.FeignClient;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestParam;

@FeignClient(name = "inventory-service", url = "${app.inventory.url}", path = "/api/inventory")
public interface InventoryClient {

    @GetMapping("/{sku}")
    Stock getStock(@PathVariable("sku") String sku);

    @PostMapping("/{sku}/reservations")
    void reserve(@PathVariable("sku") String sku, @RequestParam("qty") int quantity);

    record Stock(String sku, int available) {}
}
