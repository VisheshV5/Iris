import { findBusiness } from "../src/places.js";
const r = await findBusiness(process.argv[2] ?? "Chase Center", process.argv[3] ?? "San Francisco, CA");
console.log(JSON.stringify(r, null, 2));
