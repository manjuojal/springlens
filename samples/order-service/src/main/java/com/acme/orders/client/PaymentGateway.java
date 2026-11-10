package com.acme.orders.client;

import java.math.BigDecimal;
import java.util.Map;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;
import org.springframework.web.reactive.function.client.WebClient;
import org.springframework.web.reactive.function.client.WebClientResponseException;

/** Talks to the external payment provider over HTTP. */
@Slf4j
@Component
public class PaymentGateway {

    private static final BigDecimal MAX_AMOUNT = new BigDecimal("10000");

    private final WebClient paymentWebClient;

    public PaymentGateway(WebClient paymentWebClient) {
        this.paymentWebClient = paymentWebClient;
    }

    public String authorize(Long orderId, BigDecimal amount) {
        log.info("Authorizing payment of {} for order {}", amount, orderId);
        if (amount.compareTo(MAX_AMOUNT) > 0) {
            log.warn("Amount {} exceeds single-transaction limit", amount);
            throw new PaymentDeclinedException("Amount exceeds limit for order " + orderId);
        }
        try {
            String ref = paymentWebClient.post()
                    .uri("/v2/authorizations")
                    .bodyValue(Map.of("orderId", orderId, "amount", amount))
                    .retrieve()
                    .bodyToMono(String.class)
                    .block();
            log.info("Payment authorized for order {}: {}", orderId, ref);
            return ref;
        } catch (WebClientResponseException ex) {
            log.error("Payment provider rejected order {}: HTTP {}", orderId, ex.getStatusCode().value());
            throw new PaymentDeclinedException("Payment declined for order " + orderId, ex);
        }
    }

    public void voidAuthorization(String paymentRef) {
        paymentWebClient.delete().uri("/v2/authorizations/{ref}", paymentRef).retrieve().toBodilessEntity().block();
    }
}
