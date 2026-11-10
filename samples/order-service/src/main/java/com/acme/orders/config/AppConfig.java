package com.acme.orders.config;

import org.apache.kafka.clients.admin.NewTopic;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.reactive.function.client.WebClient;
import org.springframework.web.servlet.config.annotation.InterceptorRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;
import com.acme.orders.web.RequestLoggingInterceptor;

@Configuration
public class AppConfig implements WebMvcConfigurer {

    /** Payment gateway client, base URL comes from app.payment.base-url */
    @Bean
    public WebClient paymentWebClient(PaymentProperties props) {
        return WebClient.builder().baseUrl(props.baseUrl()).build();
    }

    @Bean
    public NewTopic orderEventsTopic(@Value("${app.kafka.order-topic}") String topic) {
        return new NewTopic(topic, 3, (short) 1);
    }

    @Override
    public void addInterceptors(InterceptorRegistry registry) {
        registry.addInterceptor(new RequestLoggingInterceptor()).addPathPatterns("/api/**");
    }

    @ConfigurationProperties(prefix = "app.payment")
    public record PaymentProperties(String baseUrl, int timeoutMs) {}
}
