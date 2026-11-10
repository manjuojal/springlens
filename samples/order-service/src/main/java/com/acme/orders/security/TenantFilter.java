package com.acme.orders.security;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.UUID;
import lombok.extern.slf4j.Slf4j;
import org.slf4j.MDC;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

/** Assigns a correlation id (MDC) and reads the tenant header for every request. */
@Slf4j
@Component
public class TenantFilter extends OncePerRequestFilter {

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws IOException, ServletException {
        String correlationId = request.getHeader("X-Correlation-Id");
        if (correlationId == null || correlationId.isBlank()) {
            correlationId = UUID.randomUUID().toString();
        }
        MDC.put("correlationId", correlationId);
        String tenant = request.getHeader("X-Tenant-Id");
        TenantContext.set(tenant);
        log.info("Incoming request {} {} (tenant {})", request.getMethod(), request.getRequestURI(), tenant);
        try {
            chain.doFilter(request, response);
            log.info("Completed {} {} with status {}", request.getMethod(), request.getRequestURI(), response.getStatus());
        } finally {
            TenantContext.clear();
            MDC.remove("correlationId");
        }
    }

    public static final class TenantContext {
        private static final ThreadLocal<String> CURRENT = new ThreadLocal<>();
        public static void set(String t) { CURRENT.set(t); }
        public static String get() { return CURRENT.get(); }
        public static void clear() { CURRENT.remove(); }
    }
}
