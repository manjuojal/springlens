package com.acme.orders.service;

import com.acme.orders.domain.Order;
import com.acme.orders.repository.ProductRepository;
import java.math.BigDecimal;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

@Service
public class PricingService {

    private static final Logger log = LoggerFactory.getLogger(PricingService.class);
    private static final BigDecimal DISCOUNT_THRESHOLD = BigDecimal.valueOf(500);

    private final ProductRepository productRepository;

    public PricingService(ProductRepository productRepository) {
        this.productRepository = productRepository;
    }

    public BigDecimal priceOrder(Order order) {
        BigDecimal total = BigDecimal.ZERO;
        for (var item : order.getItems()) {
            var product = productRepository.findBySku(item.getSku()).orElseThrow();
            total = total.add(product.getPrice().multiply(BigDecimal.valueOf(item.getQuantity())));
        }
        log.debug("Order subtotal is {}", total);
        return applyDiscounts(total);
    }

    private BigDecimal applyDiscounts(BigDecimal total) {
        if (total.compareTo(DISCOUNT_THRESHOLD) > 0) {
            log.info("Applying 5% discount on total {}", total);
            return total.multiply(new BigDecimal("0.95"));
        }
        return total;
    }
}
