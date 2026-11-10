package com.acme.orders.web;

import com.acme.orders.client.PaymentDeclinedException;
import com.acme.orders.service.CustomerBlockedException;
import com.acme.orders.service.OrderNotFoundException;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpStatus;
import org.springframework.http.ProblemDetail;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestControllerAdvice;

@Slf4j
@RestControllerAdvice
public class GlobalExceptionHandler {

    @ExceptionHandler(OrderNotFoundException.class)
    @ResponseStatus(HttpStatus.NOT_FOUND)
    public ProblemDetail notFound(OrderNotFoundException ex) {
        return ProblemDetail.forStatusAndDetail(HttpStatus.NOT_FOUND, ex.getMessage());
    }

    @ExceptionHandler(PaymentDeclinedException.class)
    @ResponseStatus(HttpStatus.PAYMENT_REQUIRED)
    public ProblemDetail paymentDeclined(PaymentDeclinedException ex) {
        log.error("Request failed: {}", ex.getMessage(), ex);
        return ProblemDetail.forStatusAndDetail(HttpStatus.PAYMENT_REQUIRED, ex.getMessage());
    }

    @ExceptionHandler(CustomerBlockedException.class)
    @ResponseStatus(HttpStatus.FORBIDDEN)
    public ProblemDetail blocked(CustomerBlockedException ex) {
        log.warn("Request rejected: {}", ex.getMessage());
        return ProblemDetail.forStatusAndDetail(HttpStatus.FORBIDDEN, ex.getMessage());
    }

    @ExceptionHandler(MethodArgumentNotValidException.class)
    @ResponseStatus(HttpStatus.BAD_REQUEST)
    public ProblemDetail invalid(MethodArgumentNotValidException ex) {
        return ProblemDetail.forStatus(HttpStatus.BAD_REQUEST);
    }
}
