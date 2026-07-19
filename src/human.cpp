#include <iostream>
#include <string>

class Human {
public:
    std::string name;
    int age;
    std::string birthday;

    Human(std::string n, int a, std::string b) : name(n), age(a), birthday(b) {}

    void printInfo() {
        std::cout << "Name: " << name << std::endl;
        std::cout << "Alter: " << age << std::endl;
        std::cout << "Geburtsdatum: " << birthday << std::endl;
    }
};

int main() {
    Human h("Max Mustermann", 30, "01.01.1990");
    h.printInfo();
    return 0;
}
