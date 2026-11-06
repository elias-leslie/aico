// Test vectors made with Python's cryptography exactly as root's verifier does it. The salt, info and AAD strings in
// seal.rs are a contract with stored keys, so these values must never change.
pub const PRF_HMAC_SALT: &str = "hQfR5oBGD42TYVUw8vL7pbUoFLxbFNubtKIiLUhYmdI";
pub const TRANSPORT: &str = "64a7e8d5fd7125deffefd880013c24f241e95d1f183c311da5b45d5ad4290c74";
pub const TRANSPORT_PUB: &str = "BOtkaI4Wj2DTdCwBv99sYVcXYCSvVLAvZVP9H5S3MfKpp1ewsCIqEEpmolrP9eaLwOjYokevrwsodqHmhjB7jgI";
pub const EPH: &str = "3eb24dc368c873124619f4cf952f40d5d2732caec50f03647ed4bcf8f2d52790";
pub const EPH_PUB: &str = "BE4j-3R66tf46q-uBNer_lk3blUqRmGv5B5z60AB1X3st6XN3i6E30j3mdoyNE-QUTYNyofqBsPbc8layvx0njE";
pub const IV: &str = "b4674f27cc7d865476a21ca9";
pub const PRF_CT: &str = "z6MhHuBNFtyuLYuERHZnam0cx3lB9HAd-WKGEKIfIPYxfA9huAEmsgc_dzNOvvY4";
