use std::{env, fs, path::PathBuf};

fn main() {
    let catalog = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap())
        .join("../lib/slots.json");
    println!("cargo:rerun-if-changed={}", catalog.display());
    println!("cargo:rerun-if-changed=build.rs");
    let slots: serde_json::Value =
        serde_json::from_slice(&fs::read(catalog).expect("read shared slot catalog"))
            .expect("parse shared slot catalog");
    let slots = slots.as_array().expect("catalog must be an array");
    assert_eq!(slots.len(), 62, "the market contains exactly 62 advertising slots");
    let areas: Vec<u64> = slots
        .iter()
        .enumerate()
        .map(|(id, slot)| {
            assert_eq!(slot["id"].as_u64(), Some(id as u64), "slot IDs must stay contiguous");
            slot["width"]
                .as_u64()
                .expect("positive integer width")
                .checked_mul(slot["height"].as_u64().expect("positive integer height"))
                .expect("area overflow")
        })
        .collect();
    assert_eq!(areas.iter().min(), Some(&1_600));
    assert_eq!(areas.iter().max(), Some(&264_000));
    // Approved initial prices: 0.1–2 SOL, proportional to catalog area.
    // Integer half-up rounding to 0.001 SOL avoids floating point on chain.
    let min_area = 1_600_u64;
    let spread = 264_000_u64 - min_area;
    let denominator = spread * 1_000_000;
    let prices: Vec<u64> = areas
        .iter()
        .map(|area| {
            let numerator = (area - min_area) * 1_900_000_000;
            100_000_000 + ((numerator + denominator / 2) / denominator) * 1_000_000
        })
        .collect();
    assert_eq!(prices.iter().min(), Some(&100_000_000));
    assert_eq!(prices.iter().max(), Some(&2_000_000_000));
    let generated = format!(
        "pub const SLOT_COUNT: usize = {};\npub const BASE_PRICES: [u64; SLOT_COUNT] = {:?};\n",
        slots.len(), prices
    );
    fs::write(
        PathBuf::from(env::var("OUT_DIR").unwrap()).join("catalog.rs"),
        generated,
    )
    .expect("write compile-time price catalog");
}
