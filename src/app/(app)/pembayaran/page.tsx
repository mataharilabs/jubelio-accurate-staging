import { FeeReports } from "@/components/fee-reports";
import { PaymentEntry } from "@/components/payment-entry";
import { PembayaranView } from "@/components/pembayaran-view";

export default function Page() {
  return (
    <>
      <PembayaranView />
      <PaymentEntry />
      <FeeReports />
    </>
  );
}
