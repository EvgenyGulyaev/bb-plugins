import { configure } from "@testing-library/react";

configure({ asyncUtilTimeout: 8_000 });
process.env.NODE_ENV = "test";
