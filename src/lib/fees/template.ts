import * as XLSX from "xlsx";

export function feeTemplate(): Buffer {
  const rows = [
    ["no_pesanan", "sku", "grup_biaya", "nama_biaya", "nominal", "persen"],
    ["2611015H350RJH", "SKU-CONTOH", "Komisi", "Komisi marketplace", 1500, 9],
    ["2611015H350RJH", "", "Pajak", "PPh 22", 100, ""],
  ];
  const book = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  sheet["!cols"] = [{ wch: 22 }, { wch: 16 }, { wch: 28 }, { wch: 28 }, { wch: 14 }, { wch: 10 }];
  XLSX.utils.book_append_sheet(book, sheet, "Biaya");
  const note = XLSX.utils.aoa_to_sheet([
    ["Kolom", "Isi"],
    ["no_pesanan", "Sama dengan No Pesanan di Jubelio"],
    ["sku", "Kosongkan bila biaya untuk seluruh pesanan"],
    ["grup_biaya", "Komisi, Biaya layanan/program, Biaya pembayaran, Biaya proses pesanan, Ongkir ditanggung penjual, Komisi afiliasi, Pajak, Lain-lain"],
    ["nama_biaya", "Nama asli biaya"],
    ["nominal", "Rupiah. Positif = biaya yang mengurangi profit, kecuali grup Pajak"],
    ["persen", "Opsional. Contoh 9 untuk 9%"],
  ]);
  XLSX.utils.book_append_sheet(book, note, "Petunjuk");
  return XLSX.write(book, { type: "buffer", bookType: "xlsx" }) as Buffer;
}
