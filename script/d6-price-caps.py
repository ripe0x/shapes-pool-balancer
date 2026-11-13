import sys, math
SH=0x3323232111111111
units=lambda d:(SH>>(4*d))&0xF
amt={0:10**16,1:5*10**16,2:10**17,3:5*10**17,9:2*10**16}
L={};M={}
for line in open(sys.argv[1]):
    line=line.strip()
    if line.startswith('L,'):
        _,b,k,d,base,price,w=line.split(','); L.setdefault(int(b),[]).append((int(k),int(d),int(base),int(price),int(w)))
    if line.startswith('M,'):
        _,b,fee,vrf,tot,rf,r1,rn=line.split(','); M[int(b)]=dict(fee=int(fee),vrf=int(vrf),tot=int(tot),rf=int(rf),r1=int(r1),rn=int(rn))
E=lambda x:x/1e18
def board(b,cap):
    m=M[b]; out=[]
    for k,d,base,price,w in L[b]:
        if k==2:
            u=units(d)
            rfc=0 if cap==0 else 900000*min(b+5*10**7,cap)+2*10**14
            p=price-u*m['rf']+u*rfc
        else: p=price
        out.append((k,d,p,10**36//p))
    return out
def quote(bd):
    W=sum(x[3] for x in bd); WP=sum(x[3]*x[2] for x in bd)
    base=WP//W; return base, base*10500//10000
for b in sorted(M):
    m=M[b]
    # validation at the current cap (5 gwei): rebuild with the same fee
    bd=board(b,5*10**9); base5,fee5=quote(bd)
    assert fee5==m['fee'], (b,fee5,m['fee'])
    W=sum(x[3] for x in bd)
    P={}
    ev_back=sum(x[3]*amt[x[1]] for x in bd if x[0]==2)/W
    ev_nft=sum(x[3]*2*10**17 for x in bd if x[0]==1)/W
    units_per_draw=sum(x[3]*units(x[1]) for x in bd if x[0]==2)/W
    p_nft=sum(x[3] for x in bd if x[0]==1)/W
    keeper=units_per_draw*m['r1']+p_nft*m['rn']
    base0,fee0=quote(board(b,0))
    print(f"\n### basefee {E(b)*1e9:.2f} gwei (gas price +0.05): VRF {E(m['vrf']):.6f}, expected Shape backing {E(ev_back):.6f}, + NFT at 0.2 listed {E(ev_back+ev_nft):.6f}, Shape units per draw {units_per_draw:.4f}, P(NFT) {p_nft:.4f}")
    print(f"keeper pay per draw (measured 1-Shape replacement {E(m['r1']):.6f} x units + NFT reconcile {E(m['rn']):.6f} x P): {E(keeper):.6f}")
    for cap in (5*10**9,2*10**9,10**9):
        base,fee=quote(board(b,cap)); tot=fee+m['vrf']; contrib=base-base0
        print(f"cap {cap/1e9:.0f} gwei: all-in {E(tot):.6f}  ratio to Shape backing {tot/ev_back:.2f}x  to backing+NFT {tot/(ev_back+ev_nft):.2f}x  fee in owner proceeds/draw {E(contrib):.6f}  creator absorbs/draw {E(keeper-contrib):+.6f}")
    tot0=fee0+m['vrf']
    print(f"floor (no restocking fee): all-in {E(tot0):.6f} ratio {tot0/ev_back:.2f}x ({tot0/(ev_back+ev_nft):.2f}x incl NFT); VRF alone {m['vrf']/ev_back:.2f}x of Shape backing")
# spike decay: board listed fresh at 4.95 with cap 5, then gas back at 0.5
b5=4950000000; bd=board(b5,5*10**9); W=sum(x[3] for x in bd)
print("\n### after a spike: board listed at 4.95 gwei, then basefee 0.5")
excess=[]
for k,d,p,w in bd:
    if k!=2: continue
    u=units(d); dfee=u*(M[b5]['rf']-(900000*550000000+2*10**14)); excess.append((w/W,dfee))
tot=sum(e for _,e in excess)
for pct in (0.5,0.9):
    k=0
    while sum(e*(1-pp)**k for pp,e in excess)>tot*(1-pct): k+=1
    print(f"draws until {int(pct*100)}% of the spike's extra restocking fees are gone (expected): {k}")
tiers={}
for k,d,p,w in bd:
    if k==2: tiers.setdefault(d,[0,w])[0]+=1
for d,(n,w) in sorted(tiers.items(), key=lambda t: amt[t[0]]):
    print(f"tier {E(amt[d])} ETH x{n}: expected draws until one given listing is won {W/w:.0f}")

# markup sweep at each basefee, current 5 gwei fee cap: what markup meets a ratio target
print("\n### markup sweep (current fee cap), ratio of all-in price to expected Shape backing")
for b in sorted(M):
    m=M[b]; row=[]
    for mk in (2500,2000,1500,1000):
        bd=[]
        for k,d,base,price,w in L[b]:
            if k==2:
                u=units(d); mint=(price-base*12500//10000-u*m['rf'])//u
                p=base*(10000+mk)//10000+u*mint+u*m['rf']
            else: p=base*(10000+mk)//10000
            bd.append((k,d,p,10**36//p))
        W=sum(x[3] for x in bd); base_,fee=quote(bd)
        ev=sum(x[3]*amt[x[1]] for x in bd if x[0]==2)/W
        row.append(f"{mk/100:.0f}%: {(fee+m['vrf'])/ev:.2f}x")
    print(f"basefee {b/1e9:.2f} gwei: "+"  ".join(row))
