plugins {
    java
    application
}

repositories {
    mavenCentral()
}

dependencies {
    implementation("ai.keycard:keycard-a2a:0.10.0")
    implementation("ai.keycard:keycard-mcp:0.10.0")
    implementation("org.eclipse.jetty.ee10:jetty-ee10-servlet:12.1.15")
    // The official a2a-java types and codec for agent cards and JSON-RPC messages.
    implementation("org.a2aproject.sdk:a2a-java-sdk-spec-grpc:1.5.1.Final")
    implementation("com.google.protobuf:protobuf-java-util:4.36.2")
    implementation("com.google.code.gson:gson:2.15.0")
    implementation("com.nimbusds:nimbus-jose-jwt:10.10")
    runtimeOnly("org.slf4j:slf4j-simple:2.0.20")
}

application {
    mainClass.set("example.Agent")
}

tasks.withType<JavaCompile>().configureEach {
    options.release.set(17)
    options.compilerArgs.addAll(listOf("-Xlint:deprecation", "-Werror"))
}
