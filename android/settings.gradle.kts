pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
        // GeckoView (stable channel) lives on Mozilla Maven, not Central.
        maven { url = uri("https://maven.mozilla.org/maven2/") }
    }
}
rootProject.name = "filter-platform"
include(":app")
