// Generates order-service.log with three correlated requests (payment failure, success, blocked customer).
// Line numbers in stack traces are computed from the actual sources so they always match the code.
const fs = require('fs');
const path = require('path');
const SRC = path.join(__dirname, '..', 'src', 'main', 'java', 'com', 'acme', 'orders');
const L = (file, snippet, nth = 1) => {
  const lines = fs.readFileSync(path.join(SRC, file), 'utf8').split('\n');
  let seen = 0;
  for (let i = 0; i < lines.length; i++) if (lines[i].includes(snippet) && ++seen === nth) return i + 1;
  throw new Error(`${snippet} not found in ${file}`);
};

const FAIL = 'c0ffee42-9b1e-4d0a-8c5f-1a2b3c4d5e6f';
const OK = '5b7e1d20-3f4a-4c6b-9e8d-7a6b5c4d3e2f';
const BLOCKED = '9a8b7c6d-1e2f-4a3b-8c9d-0e1f2a3b4c5d';

let t = Date.parse('2026-11-10T10:15:30.000Z');
const out = [];
const log = (level, thread, corr, logger, msg, ms = 7) => {
  t += ms;
  const ts = new Date(t).toISOString().replace('Z', '+00:00');
  out.push(`${ts} ${level.padStart(5)} 4242 --- [order-service] [${thread.padStart(15)}] [${corr || ''}] ${logger.padEnd(40)} : ${msg}`);
};
const raw = (l) => out.push(l);

// startup noise
log('INFO', 'main', '', 'c.a.orders.OrderServiceApplication', 'Starting OrderServiceApplication using Java 21');
log('INFO', 'main', '', 'o.s.b.w.embedded.tomcat.TomcatWebServer', 'Tomcat started on port 8081 (http) with context path \'/orders-api\'');
log('INFO', 'main', '', 'c.a.orders.OrderServiceApplication', 'Started OrderServiceApplication in 4.21 seconds');

// ---------- request 1: payment declined (interleaved with request 2) ----------
const F = 'nio-8081-exec-3'; const S = 'nio-8081-exec-5';
log('INFO', F, FAIL, 'c.a.orders.security.TenantFilter', 'Incoming request POST /orders-api/api/v1/orders (tenant acme-eu)', 120);
log('INFO', F, FAIL, 'c.a.orders.service.OrderServiceImpl', 'Placing order for customer 42 with 2 items');
log('INFO', S, OK, 'c.a.orders.security.TenantFilter', 'Incoming request POST /orders-api/api/v1/orders (tenant acme-us)', 3);
log('DEBUG', F, FAIL, 'c.a.orders.service.OrderServiceImpl', 'Reserving 3 x SKU-LAPTOP-15');
log('INFO', S, OK, 'c.a.orders.service.OrderServiceImpl', 'Placing order for customer 7 with 1 items', 2);
log('DEBUG', F, FAIL, 'c.a.orders.service.OrderServiceImpl', 'Reserving 1 x SKU-DOCK-USB-C', 31);
log('DEBUG', S, OK, 'c.a.orders.service.OrderServiceImpl', 'Reserving 2 x SKU-MOUSE-01', 4);
log('DEBUG', F, FAIL, 'c.a.orders.service.PricingService', 'Order subtotal is 4087.00', 22);
log('INFO', F, FAIL, 'c.a.orders.service.PricingService', 'Applying 5% discount on total 4087.00', 1);
log('DEBUG', S, OK, 'c.a.orders.service.PricingService', 'Order subtotal is 49.90', 6);
log('INFO', F, FAIL, 'c.a.orders.service.OrderServiceImpl', 'Order 1001 saved with total 3882.65', 18);
log('INFO', S, OK, 'c.a.orders.service.OrderServiceImpl', 'Order 1002 saved with total 49.90', 3);
log('INFO', F, FAIL, 'c.a.orders.client.PaymentGateway', 'Authorizing payment of 3882.65 for order 1001', 1);
log('INFO', S, OK, 'c.a.orders.client.PaymentGateway', 'Authorizing payment of 49.90 for order 1002', 5);
log('ERROR', F, FAIL, 'c.a.orders.client.PaymentGateway', 'Payment provider rejected order 1001: HTTP 402', 640);
log('INFO', S, OK, 'c.a.orders.client.PaymentGateway', 'Payment authorized for order 1002: AUTH-7731-XK', 12);
log('ERROR', F, FAIL, 'c.a.orders.web.GlobalExceptionHandler', 'Request failed: Payment declined for order 1001', 4);
raw(`com.acme.orders.client.PaymentDeclinedException: Payment declined for order 1001`);
raw(`\tat com.acme.orders.client.PaymentGateway.authorize(PaymentGateway.java:${L('client/PaymentGateway.java', 'throw new PaymentDeclinedException("Payment declined')})`);
raw(`\tat com.acme.orders.service.OrderServiceImpl.placeOrder(OrderServiceImpl.java:${L('service/OrderServiceImpl.java', 'paymentGateway.authorize(')})`);
raw(`\tat java.base/jdk.internal.reflect.DirectMethodHandleAccessor.invoke(DirectMethodHandleAccessor.java:103)`);
raw(`\tat org.springframework.aop.support.AopUtils.invokeJoinpointUsingReflection(AopUtils.java:355)`);
raw(`\tat org.springframework.transaction.interceptor.TransactionInterceptor.invoke(TransactionInterceptor.java:119)`);
raw(`\tat com.acme.orders.service.OrderServiceImpl$$SpringCGLIB$$0.placeOrder(<generated>)`);
raw(`\tat com.acme.orders.web.OrderController.create(OrderController.java:${L('web/OrderController.java', 'orderService.placeOrder(request)')})`);
raw(`\tat org.springframework.web.servlet.FrameworkServlet.service(FrameworkServlet.java:885)`);
raw(`\tat com.acme.orders.security.TenantFilter.doFilterInternal(TenantFilter.java:${L('security/TenantFilter.java', 'chain.doFilter(request, response)')})`);
raw(`\tat org.springframework.web.filter.OncePerRequestFilter.doFilter(OncePerRequestFilter.java:116)`);
raw(`\t... 48 common frames omitted`);
raw(`Caused by: org.springframework.web.reactive.function.client.WebClientResponseException$PaymentRequired: 402 Payment Required from POST https://payments.acme.com/api/v2/authorizations`);
raw(`\tat org.springframework.web.reactive.function.client.WebClientResponseException.create(WebClientResponseException.java:336)`);
raw(`\tat reactor.core.publisher.BlockingSingleSubscriber.blockingGet(BlockingSingleSubscriber.java:129)`);
raw(`\tat reactor.core.publisher.Mono.block(Mono.java:1807)`);
raw(`\tat com.acme.orders.client.PaymentGateway.authorize(PaymentGateway.java:${L('client/PaymentGateway.java', '.block();')})`);
raw(`\t... 61 common frames omitted`);
log('INFO', F, FAIL, 'c.a.orders.security.TenantFilter', 'Completed POST /orders-api/api/v1/orders with status 402', 3);

log('INFO', S, OK, 'c.a.orders.service.OrderServiceImpl', 'Order 1002 published to order-events', 9);
log('INFO', S, OK, 'c.a.orders.security.TenantFilter', 'Completed POST /orders-api/api/v1/orders with status 201', 4);

// ---------- request 3: blocked customer ----------
const B = 'nio-8081-exec-8';
log('INFO', B, BLOCKED, 'c.a.orders.security.TenantFilter', 'Incoming request POST /orders-api/api/v1/orders (tenant acme-eu)', 2200);
log('INFO', B, BLOCKED, 'c.a.orders.service.OrderServiceImpl', 'Placing order for customer 99 with 1 items');
log('WARN', B, BLOCKED, 'c.a.orders.service.OrderServiceImpl', 'Customer 99 is blocked, order refused', 15);
log('WARN', B, BLOCKED, 'c.a.orders.web.GlobalExceptionHandler', 'Request rejected: Customer 99 is blocked', 2);
log('INFO', B, BLOCKED, 'c.a.orders.security.TenantFilter', 'Completed POST /orders-api/api/v1/orders with status 403', 1);

fs.writeFileSync(path.join(__dirname, 'order-service.log'), out.join('\n') + '\n');
console.log(`wrote ${out.length} lines → logs/order-service.log`);
console.log(`correlation ids:\n  payment declined: ${FAIL}\n  success:          ${OK}\n  blocked customer: ${BLOCKED}`);
