#!/bin/sh
set -eu

mkdir -p src

case "${HARNESS_TASK:-}" in
  *OrderService*)
    cat > src/order-service.ts <<'EOF'
import { Order } from './domain-model';

export class OrderService {
  create(id: string): Order {
    return { id, status: 'created' };
  }
}
EOF
    echo "wrote src/order-service.ts"
    ;;
  *"Order domain model"*)
    cat > src/domain-model.ts <<'EOF'
export interface Order {
  id: string;
  status: 'created' | 'paid' | 'cancelled';
}
EOF
    echo "wrote src/domain-model.ts"
    ;;
  *)
    echo "Unknown task: ${HARNESS_TASK:-}" >&2
    exit 1
    ;;
esac
