package com.acme.orders.repository;

import com.acme.orders.domain.Order;
import com.acme.orders.domain.OrderStatus;
import java.time.Instant;
import java.util.List;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface OrderRepository extends JpaRepository<Order, Long> {

    List<Order> findByTenant(String tenant);

    List<Order> findByTenantAndStatus(String tenant, OrderStatus status);

    @Modifying
    @Query("update Order o set o.status = :status where o.id = :id")
    int updateStatus(@Param("id") Long id, @Param("status") OrderStatus status);

    @Modifying
    @Query(value = "delete from orders where status = 'NEW' and created_at < :before", nativeQuery = true)
    int deleteStaleOrders(@Param("before") Instant before);
}
