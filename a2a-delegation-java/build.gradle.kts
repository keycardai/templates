plugins {
    java
    application
}

repositories {
    mavenCentral()
}

dependencies {
    // Keycard: the A2A delegation client (pulls in keycard-oauth, whose Nimbus dependency
    // supplies the JSON codec the agents use).
    implementation("ai.keycard:keycard-a2a:0.9.0")
    // Keycard: the bearer-token filter and OAuth metadata servlets.
    implementation("ai.keycard:keycard-mcp:0.9.0")
    // Embedded Jetty supplies the Servlet API that keycard-mcp compiles against.
    implementation("org.eclipse.jetty.ee10:jetty-ee10-servlet:12.1.15")
    runtimeOnly("org.slf4j:slf4j-simple:2.0.17")
}

application {
    mainClass.set("example.Agent")
}

// Compiles for Java 17, the floor the Keycard SDK supports, on any newer JDK.
tasks.withType<JavaCompile>().configureEach {
    options.release.set(17)
    options.compilerArgs.addAll(listOf("-Xlint:deprecation", "-Werror"))
}
