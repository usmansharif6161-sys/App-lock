export type Product = {
  id: string;
  name: string;
  price: number;
  description: string | null;
  created_at: string;
};

export type Customer = {
  id: string;
  name: string;
  phone: string;
  cnic?: string | null;
  alternate_phone?: string | null;
  address: string | null;
  created_at: string;
};

export type InstallmentStatus = 'active' | 'completed';
export type PaymentStatus = 'unpaid' | 'paid' | 'overdue' | 'pending_approval';

export type Installment = {
  id: string;
  customer_id: string;
  product_id: string;
  product_price: number;
  down_payment: number;
  remaining_balance: number;
  number_of_installments: number;
  installment_amount: number;
  qr_code_ref: string;
  status: InstallmentStatus;
  is_locked: boolean;
  created_at: string;
};

export type Payment = {
  id: string;
  installment_id: string;
  installment_number: number;
  amount: number;
  due_date: string;
  status: PaymentStatus;
  paid_at: string | null;
  created_at: string;
};

export type InstallmentWithRelations = Installment & {
  customers: Pick<Customer, 'id' | 'name' | 'phone' | 'cnic' | 'alternate_phone' | 'address'> | null;
  products: Pick<Product, 'id' | 'name' | 'price'> | null;
  payments: Payment[];
};

export function formatMoney(value: number | string): string {
  const amount = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(amount)) return 'PKR 0';
  return `PKR ${Math.round(amount).toLocaleString('en-PK')}`;
}

export function resolvePaymentDisplayStatus(
  status: string,
  dueDate: string,
  today = new Date().toISOString().slice(0, 10)
): 'paid' | 'unpaid' | 'overdue' {
  if (status === 'paid') return 'paid';
  if (dueDate < today) return 'overdue';
  return 'unpaid';
}
