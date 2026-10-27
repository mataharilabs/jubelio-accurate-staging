import pandas as pd, warnings, sys; warnings.filterwarnings('ignore')
src, bobotf, fn = sys.argv[1], sys.argv[2], sys.argv[3]
df=pd.read_excel(src, dtype={'REF':str,'SKU':str,'item_code_bundle':str,'No Pesanan':str})
b=pd.read_excel(bobotf, header=None, dtype=str).iloc[:,1:3].dropna()
b.columns=['key','bobot']; b=b[b['key']!='SKU BUNDLE']; b['key']=b['key'].str.strip(); b['bobot']=b['bobot'].astype(float)
bmap=dict(zip(b['key'],b['bobot']))
df=df[~df['Status'].str.upper().isin(['PENDING','PAID','CANCELED','CANCELLED','CANCEL'])].copy()
for c in ['Qty','Harga Jual','Total Penjualan Per Produk','Diskon','Diskon Lainnya','Biaya Lainnya','qty_bundle']:
    df[c]=pd.to_numeric(df[c],errors='coerce').fillna(0)
isb=df['item_code_bundle'].notna() & (df['item_code_bundle'].str.strip()!='')
shp=df['Channel'].str.upper().str.strip().eq('SHOPEE')
ref=df['REF'].where(df['REF'].notna() & (df['REF'].str.strip()!=''), df['No Pesanan'])
key=(df['SKU'].str.strip()+'-'+df['item_code_bundle'].fillna('').str.strip()).where(isb,'')
w=key.map(bmap).where(isb,1.0)
gross=(df['Total Penjualan Per Produk']*w).where(shp, df['Qty']*df['Harga Jual']*w)
disc=(df['Diskon Lainnya']*w).where(shp,(df['Diskon']+df['Diskon Lainnya']+df['Biaya Lainnya'])*w)
out=pd.DataFrame({'No Pesanan':ref,'Channel':df['Channel'],'SKU':df['item_code_bundle'].where(isb, df['SKU']),
 'Qty':(df['qty_bundle']*df['Qty']).where(isb, df['Qty']).astype(int),
 'Harga Jual':gross,'Total Diskon':disc})
miss=key[isb & w.isna()]
with pd.ExcelWriter(fn, engine='openpyxl') as x:
  out.to_excel(x,index=False,sheet_name='Data'); ws=x.sheets['Data']
  for c,wd in zip('ABCDEF',[40,18,20,8,16,16]): ws.column_dimensions[c].width=wd
  for r in range(2,len(out)+2):
    for c in (5,6): ws.cell(r,c).number_format='#,##0.##'
print('rows',len(out),'shopee',shp.sum(),'bundle',isb.sum(),'missing',sorted(set(miss)))
print('gross',round(gross.sum()),'disc',round(disc.sum()))
print(out.head(6).to_string()); print(out[shp.values].head(4).to_string())
