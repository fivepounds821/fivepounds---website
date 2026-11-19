-- Award Sweet Circle stamps based on the order's fulfillment date,
-- not the date the customer originally placed the order.
create or replace function public.award_fivepounds_stamp()
returns trigger
language plpgsql
set search_path to ''
as $function$
begin
  if new.preferred_date >= date '2026-11-21'
     and new.status = 'completed'
     and new.paid = true
     and new.rewards_opt_in_at_order = true then
    insert into public.loyalty_transactions (
      customer_id, order_id, transaction_type, stamps_delta, description
    )
    values (
      new.customer_id, new.id, 'earned', 1, 'Completed and paid order'
    )
    on conflict (order_id, transaction_type) do nothing;
  end if;

  return new;
end;
$function$;
