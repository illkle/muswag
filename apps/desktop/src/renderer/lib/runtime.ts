import { db } from "#/lib/db-renderer.ts";
import { MuswagDatabase, SubsonicCrypto } from "@muswag/shared";
import { SyncManager } from "@muswag/shared";
import { Layer, ManagedRuntime } from "effect";



const Crypto = Layer.succeed(SubsonicCrypto, {
    md5: 
})

const AppLayer = Layer.provideMerge(Layer.succeed(MuswagDatabase, db), Layer.effect(SyncManager, SyncManager.make));
