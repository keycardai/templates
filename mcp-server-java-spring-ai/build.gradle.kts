plugins {
    java
    application
}

repositories {
    mavenCentral()
}

dependencies {
    implementation(platform("org.springframework.boot:spring-boot-dependencies:4.1.2"))
    implementation(platform("org.springframework.ai:spring-ai-bom:2.0.2"))
    implementation(platform("io.modelcontextprotocol.sdk:mcp-bom:2.2.0"))
    implementation("org.springframework.ai:spring-ai-starter-mcp-server-webmvc")
    implementation("ai.keycard:keycard-spring-boot-starter:0.10.0")
}

application {
    mainClass.set("example.Application")
}

tasks.withType<JavaCompile>().configureEach {
    options.release.set(17)
    options.compilerArgs.addAll(listOf("-Xlint:deprecation", "-Werror", "-parameters"))
}
