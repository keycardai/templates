plugins {
    java
    application
}

repositories {
    mavenCentral()
}

dependencies {
    // Keycard: bearer-token filter and OAuth metadata servlets (pulls in keycard-oauth).
    implementation("ai.keycard:keycard-mcp:0.10.0")
    implementation("com.nimbusds:nimbus-jose-jwt:10.10")
    // The official MCP Java SDK and its Streamable HTTP servlet transport.
    implementation("io.modelcontextprotocol.sdk:mcp:2.2.0")
    // Embedded Jetty supplies the Servlet API that keycard-mcp compiles against.
    implementation("org.eclipse.jetty.ee10:jetty-ee10-servlet:12.1.15")
    runtimeOnly("org.slf4j:slf4j-simple:2.0.20")
}

application {
    mainClass.set("example.Server")
}

// Compiles for Java 17, the floor keycard-mcp supports, on any newer JDK.
tasks.withType<JavaCompile>().configureEach {
    options.release.set(17)
    options.compilerArgs.addAll(listOf("-Xlint:deprecation", "-Werror"))
}
